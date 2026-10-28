import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutAccessToken, isSale, stateMessage } from '../server/checkout/lifecycle.js';
import type { Checkout, SaleEvidence } from '../server/contracts.js';

test('any purchase commitment prevents expiry, including pending payment',()=>{
 const base:SaleEvidence={committed:false,quantitySold:0,listingActive:true,listingId:'1',sku:'wc-test',observedAt:new Date().toISOString(),orderIds:[],paymentStatuses:[]};
 assert.equal(isSale(base),false);
 assert.equal(isSale({...base,quantitySold:1}),true);
 assert.equal(isSale({...base,orderIds:['order'],paymentStatuses:['PENDING']}),true);
 assert.equal(isSale({...base,committed:true}),true);
});
test('checkout status token is deterministic per server-owned ID, not a client price',()=>{
 const old=process.env.MANUS_JWT_SECRET; process.env.MANUS_JWT_SECRET='test-only-not-production';
 assert.equal(checkoutAccessToken('a'),checkoutAccessToken('a')); assert.notEqual(checkoutAccessToken('a'),checkoutAccessToken('b'));
 if(old===undefined)delete process.env.MANUS_JWT_SECRET;else process.env.MANUS_JWT_SECRET=old;
});
test('status messages do not imply paid orders are cancelled or public listings reserved',()=>{
 const c={state:'COMMITTED'} as Checkout; assert.match(stateMessage(c),/will not cancel/);
 assert.match(stateMessage({...c,state:'ACTIVE'}),/public listing/);
 assert.match(stateMessage({...c,state:'ENDED_UNSOLD'}),/bag is retained/);
});
