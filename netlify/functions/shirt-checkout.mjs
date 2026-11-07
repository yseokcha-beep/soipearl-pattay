// Dedicated Stripe Checkout for shirt orders: HTTP API, no additional stripe npm dependency.
// This does NOT edit or reuse the site's existing Staff Gratuity pay.js.
import {getStore} from '@netlify/blobs';
import {randomUUID} from 'node:crypto';
import {SHIRT_NAMES,UNIT_BAHT,validateOrder,json} from '../lib/shirt-core.mjs';

const stripeKey=()=>process.env.SHIRT_STRIPE_SECRET_KEY||process.env.STRIPE_SECRET_KEY;
const configured=()=>process.env.SHIRT_SALES_ENABLED==='true'&&Boolean(stripeKey())&&Boolean(process.env.SHIRT_STRIPE_WEBHOOK_SECRET);

export default async function handler(request){
 if(request.method==='GET')return json({enabled:configured()});
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(!configured())return json({error:'Shirt checkout is not enabled or signed webhook is not configured'},503);
 const url=new URL(request.url),origin=request.headers.get('origin');
 if(origin&&origin!==url.origin)return json({error:'Invalid origin'},403);
 if(Number(request.headers.get('content-length'))>8192)return json({error:'Order too large'},413);
 let order;
 try{order=validateOrder(await request.json());}
 catch(e){return json({error:e.message||'Invalid order'},400);}
 const id='sh_'+randomUUID();
 const store=getStore({name:'soi6-shirt-orders',consistency:'strong'});
 const data={id,...order,createdAt:new Date().toISOString(),paymentStatus:'pending',paidAt:null,fulfillmentStatus:'pending'};
 try{
   await store.setJSON('order/'+id,data,{onlyIfNew:true});
   const params=new URLSearchParams();
   params.set('mode','payment');params.set('payment_method_types[0]','card');
   params.set('client_reference_id',id);params.set('metadata[shirtOrderId]',id);
   params.set('payment_intent_data[metadata][shirtOrderId]',id);
   params.set('payment_intent_data[receipt_email]',order.email);
   params.set('customer_email',order.email);
   params.set('success_url',`${url.origin}/?shirt_payment=success&session_id={CHECKOUT_SESSION_ID}`);
   params.set('cancel_url',`${url.origin}/?shirt_payment=cancelled`);
   params.set('expires_at',String(Math.floor(Date.now()/1000)+1800));
   const items=order.lines.map(line=>({name:`${SHIRT_NAMES[line.id]} / ${line.size}`,unit:UNIT_BAHT*100,qty:line.qty}));
   items.push({name:'Processing fee (6.75% + ฿10, VAT incl.)',unit:order.fee*100,qty:1});
   items.forEach((item,i)=>{
      params.set(`line_items[${i}][price_data][currency]`,'thb');
      params.set(`line_items[${i}][price_data][unit_amount]`,String(item.unit));
      params.set(`line_items[${i}][price_data][product_data][name]`,item.name);
      params.set(`line_items[${i}][quantity]`,String(item.qty));
   });
   const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{
     method:'POST',headers:{Authorization:'Bearer '+stripeKey(),'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':id},
     body:params,signal:AbortSignal.timeout(15000)});
   const session=await response.json();
   if(!response.ok||!session.url||!/^https:\/\/checkout\.stripe\.com\//.test(session.url)){
      console.error('shirt-checkout Stripe session failed',response.status,session.error?.code||'invalid_response');
      return json({error:'Could not start secure checkout. Please contact the bar.'},503);
   }
   return json({checkoutUrl:session.url,orderId:id});
 }catch(e){console.error('shirt-checkout',e?.message);return json({error:'Could not start secure checkout. Please try again.'},503);}
}
