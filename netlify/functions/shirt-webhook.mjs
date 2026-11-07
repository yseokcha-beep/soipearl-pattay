// Signed Stripe webhook for paid shirt orders; NOT the existing gratuity webhook.js.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {getStore} from '@netlify/blobs';
import {json} from '../lib/shirt-core.mjs';

function verifySignature(payload,header,secret){
  if(!header||!secret)return false;
  const fields=header.split(',').map(x=>x.trim());
  const stamp=fields.find(x=>x.startsWith('t='))?.slice(2);
  const signatures=fields.filter(x=>x.startsWith('v1=')).map(x=>x.slice(3));
  const t=Number(stamp);
  if(!Number.isInteger(t)||Math.abs(Date.now()/1000-t)>300||!signatures.length)return false;
  const expected=createHmac('sha256',secret).update(`${stamp}.${payload}`,'utf8').digest();
  return signatures.some(h=>{
    if(!/^[0-9a-f]{64}$/i.test(h))return false;
    const provided=Buffer.from(h,'hex');return timingSafeEqual(provided,expected);
  });
}
export default async function handler(request){
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 const secret=process.env.SHIRT_STRIPE_WEBHOOK_SECRET;
 if(!secret)return json({error:'Shirt webhook not configured'},503);
 const raw=await request.text();
 if(!verifySignature(raw,request.headers.get('stripe-signature'),secret))return json({error:'Invalid Stripe webhook signature'},400);
 let event;try{event=JSON.parse(raw);}catch{return json({error:'Invalid event JSON'},400);}
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return json({received:true});
 const session=event.data?.object;
 if(session?.mode!=='payment'||session?.payment_status!=='paid'||session?.currency!=='thb')return json({received:true});
 const id=String(session.metadata?.shirtOrderId||session.client_reference_id||'');
 if(!/^sh_[a-f0-9-]{36}$/.test(id))return json({error:'Invalid shirt order reference'},400);
 try{
   const store=getStore({name:'soi6-shirt-orders',consistency:'strong'}),key='order/'+id;
   for(let i=0;i<5;i++){
     const result=await store.getWithMetadata(key,{type:'json'});
     if(!result?.data)return json({error:'Unknown order; retry webhook'},503);
     const order=result.data;
     if(Math.round(order.total*100)!==session.amount_total)return json({error:'Payment/order amount mismatch'},422);
     if(order.paymentStatus==='paid')return json({received:true,alreadyProcessed:true});
     const updated={...order,paymentStatus:'paid',paidAt:new Date().toISOString(),fulfillmentStatus:'paid',
       checkoutSessionId:session.id,paymentIntentId:session.payment_intent||null};
     const done=await store.setJSON(key,updated,{onlyIfMatch:result.etag});
     if(done.modified)return json({received:true});
   }
   return json({error:'Concurrent order update; retry'},503);
 }catch(e){console.error('shirt-webhook',e);return json({error:'Order save failed; Stripe will retry'},503);}
}
