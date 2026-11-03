import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';

const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
assert.ok(option('--executable')&&option('--kernel-sha')&&option('--output'),'Provide --executable, --kernel-sha and a private --output');
const executable=await realpath(resolve(option('--executable'))),expected=option('--kernel-sha');assert.match(expected,/^[a-f0-9]{64}$/);
assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'),expected);
const output=resolve(option('--output')),temporary=await realpath(await mkdtemp(join(tmpdir(),'vesper-protocol-proof-')));
const version=JSON.parse(await readFile(new URL('../node_modules/puppeteer-core/package.json',import.meta.url),'utf8')).version;
const report={at:new Date().toISOString(),state:'running',actualInstalledProof:false,scope:'Owned native Chromium CDP and Puppeteer BiDi fixtures; not Selenium or full protocol coverage',puppeteerVersion:version,executableSha256:expected,cases:[],errors:[]};
const fixture=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><title>Owned Vesper protocol fixture</title><script>window.first={cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory};</script><label>Message <input id="message"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#message\').value;localStorage.setItem(\'vesper-protocol-proof\',document.querySelector(\'#message\').value)">Save</button><output id="result"></output>');});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+fixture.address().port;let browser;
try{
 for(const protocol of ['cdp','webDriverBiDi']){
  const launch=()=>puppeteer.launch({executablePath:executable,userDataDir:join(temporary,protocol),headless:true,protocol,args:['--no-first-run','--no-default-browser-check','--disable-background-networking','--vesper-hardware-concurrency=4','--vesper-device-memory=4'],timeout:60000});
  browser=await launch();let page=await browser.newPage();await page.goto(origin);assert.deepEqual(await page.evaluate(()=>window.first),{cpu:4,memory:4});
  await page.type('#message','Vesper protocol proof');await page.click('#save');assert.equal(await page.$eval('#result',element=>element.textContent),'Vesper protocol proof');await browser.close();browser=undefined;
  browser=await launch();page=await browser.newPage();await page.goto(origin);assert.equal(await page.evaluate(()=>localStorage.getItem('vesper-protocol-proof')),'Vesper protocol proof');await browser.close();browser=undefined;
  report.cases.push({protocol,nativeFirstScript:true,navigateTypeClickEvaluate:true,storageSurvivesRestart:true});
 }
 report.state='passed';
}catch(error){report.state='failed';report.errors.push(error.stack||String(error));process.exitCode=1;}
finally{await browser?.close().catch(()=>{});fixture.closeAllConnections();await new Promise(done=>fixture.close(done));const child=relative(await realpath(tmpdir()),temporary);assert.ok(child.startsWith('vesper-protocol-proof-')&&!child.startsWith('..')&&!isAbsolute(child));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.completedAt=new Date().toISOString();await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({state:report.state,puppeteerVersion:version,cases:report.cases.length,errors:report.errors}));}
