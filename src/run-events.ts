import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { durableWrite } from './managed/storage.js';

export interface RunEvent { sequence: number; data: string }
interface Journal { schemaVersion: 1; epoch: string; nextSequence: number; events: RunEvent[] }
const cursorPattern = /^([a-f0-9-]{36}):(0|[1-9][0-9]{0,15})$/;
const maxEvents = 512, maxBytes = 8 * 1024 * 1024, maxRecordBytes = 1024 * 1024;
export function parseEventCursor(value: string): { epoch: string; sequence: number } {
  const match = cursorPattern.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw Object.assign(new Error('Invalid event cursor.'), { statusCode: 400 });
  return { epoch: match[1]!, sequence: Number(match[2]) };
}

/** Bounded notification history. Replaying this journal never invokes a browser action. */
export class RunEventJournal extends EventEmitter {
  private journal!: Journal;
  private pending = Promise.resolve();
  private failure?: Error;
  private queuedBytes = 0;
  constructor(private file: string) { super(); }
  async init(): Promise<void> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.journal = { schemaVersion: 1, epoch: randomUUID(), nextSequence: 1, events: [] };
      await durableWrite(this.file, JSON.stringify(this.journal)); return;
    }
    const value = JSON.parse(text) as Journal;
    if (Buffer.byteLength(text) > maxBytes || value.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(value.epoch) || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 || !Array.isArray(value.events) || value.events.length > maxEvents) throw Error('Invalid run event journal; preserve it for recovery.');
    let previous = value.events[0]?.sequence ? value.events[0].sequence - 1 : value.nextSequence - 1;
    for (const event of value.events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence !== previous + 1 || typeof event.data !== 'string' || Buffer.byteLength(event.data) > maxRecordBytes || !validRun(JSON.parse(event.data))) throw Error('Invalid run event journal; preserve it for recovery.');
      previous = event.sequence;
    }
    if (previous !== value.nextSequence - 1) throw Error('Invalid run event sequence; preserve it for recovery.');
    this.journal = value;
  }
  get cursor(): string { return `${this.journal.epoch}:${this.journal.nextSequence - 1}`; }
  id(event: RunEvent): string { return `${this.journal.epoch}:${event.sequence}`; }
  private unavailable(error: unknown): Error {
    if (!this.failure) { this.failure = error instanceof Error ? error : Error('Event persistence failed'); this.emit('unavailable'); }
    return this.failure;
  }
  append(run: unknown): Promise<void> {
    let data: string;
    try {
      if (this.failure) throw this.failure;
      if (!validRun(run)) throw Error('Invalid run notification');
      data = JSON.stringify(run);
      if (Buffer.byteLength(data) > maxRecordBytes || this.queuedBytes + Buffer.byteLength(data) > maxBytes) throw Error('Run notification exceeds bounded history capacity');
    } catch (error) { return Promise.reject(this.unavailable(error)); }
    const bytes = Buffer.byteLength(data); this.queuedBytes += bytes;
    const operation = this.pending.then(async () => {
      if (this.failure) throw this.failure;
      if (this.journal.nextSequence >= Number.MAX_SAFE_INTEGER) throw Error('Run event sequence exhausted');
      const event = { sequence: this.journal.nextSequence, data };
      const next: Journal = { ...this.journal, nextSequence: event.sequence + 1, events: [...this.journal.events, event].slice(-maxEvents) };
      let contents = JSON.stringify(next);
      while (Buffer.byteLength(contents) > maxBytes && next.events.length > 1) { next.events.shift(); contents = JSON.stringify(next); }
      await durableWrite(this.file, contents);
      this.journal = next;
      this.emit('commit', event);
    }).catch(error => { throw this.unavailable(error); }).finally(() => { this.queuedBytes -= bytes; });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async flush(): Promise<void> { await this.pending; if (this.failure) throw this.failure; }
  async drain(): Promise<void> { await this.pending; }
  replay(cursor?: string): { reset: boolean; cursor: string; events: RunEvent[] } {
    if (this.failure) throw Object.assign(new Error('Event history is unavailable; refresh run state and retry after service restart.'), { statusCode: 503 });
    if (!cursor) return { reset: true, cursor: this.cursor, events: [] };
    const parsed = parseEventCursor(cursor), last = this.journal.nextSequence - 1;
    const first = this.journal.events[0]?.sequence ?? this.journal.nextSequence;
    if (parsed.epoch !== this.journal.epoch || parsed.sequence > last || parsed.sequence < first - 1) return { reset: true, cursor: this.cursor, events: [] };
    return { reset: false, cursor: this.cursor, events: this.journal.events.filter(event => event.sequence > parsed.sequence) };
  }
}
function validRun(run: unknown): run is { id: string } {
  return !!run && typeof run === 'object' && typeof (run as any).id === 'string' && (run as any).id.length > 0 && (run as any).id.length <= 200;
}
