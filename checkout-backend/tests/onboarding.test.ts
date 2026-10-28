import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { ebayCallbackUrl, DEFAULT_EBAY_CALLBACK_URL } from '../server/ebay/config.js';

function browser(owner=true, configured=false, secure=true) {
  let copied=''; let calls=0;
  const elements=new Map<string,Record<string,unknown>>();
  const context=vm.createContext({window:{isSecureContext:secure},document:{querySelector:(id:string)=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}},crypto:webcrypto,navigator:{clipboard:{writeText:async(value:string)=>{copied=value;calls++;}}},btoa:(s:string)=>Buffer.from(s,'binary').toString('base64'),console:{log:()=>{throw new Error('Do not log generated keys');}},fetch:()=>{throw new Error('Do not transmit generated keys');}});
  const source=readFileSync('public/admin.js','utf8').replace(/\ninit\(\);\s*$/,'\n');
  vm.runInContext(source,context);
  vm.runInContext(`state.me={authenticated:true,isAdmin:${owner}};state.dashboard={encryptionKeyConfigured:${configured}};`,context);
  return {run:()=>vm.runInContext('copyNewEncryptionKey()',context),value:()=>copied,calls:()=>calls,elements};
}
test('owner setup copies exactly 32 random bytes without rendering or transmitting the key',async()=>{
  const fixture=browser();await fixture.run();assert.equal(fixture.calls(),1);assert.equal(Buffer.from(fixture.value(),'base64').length,32);assert.match(fixture.value(),/^[A-Za-z0-9+/]{43}=$/);
  const status=String(fixture.elements.get('#encryptionStatus')?.textContent);assert.match(status,/protected TOKEN_ENCRYPTION_KEY/);assert.equal(status.includes(fixture.value()),false);assert.equal(fixture.elements.get('#copyEncryptionKey')?.disabled,true);
});
test('non-owner, existing-key and insecure contexts cannot use the key setup control',async()=>{
  for(const fixture of [browser(false),browser(true,true),browser(true,false,false)]){await fixture.run();assert.equal(fixture.calls(),0);assert.equal(fixture.elements.get('#encryptionStatus')?.className,'form-status error');}
});
test('eBay callback defaults to the verified permanent route and supports an explicit custom-domain override',()=>{
 const previous=process.env.EBAY_CALLBACK_URL;
 try{delete process.env.EBAY_CALLBACK_URL;assert.equal(ebayCallbackUrl(),DEFAULT_EBAY_CALLBACK_URL);assert.equal(ebayCallbackUrl(),'https://watchbuy-ko4chrlv.manus.space/api/ebay/callback');process.env.EBAY_CALLBACK_URL='https://custom.example/api/ebay/callback';assert.equal(ebayCallbackUrl(),process.env.EBAY_CALLBACK_URL);}finally{if(previous===undefined)delete process.env.EBAY_CALLBACK_URL;else process.env.EBAY_CALLBACK_URL=previous;}
});
