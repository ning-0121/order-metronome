import { getEffectiveResponsibilities } from './service';
import { MANAGER_FALLBACK_ROLES, recipientsForResponsibilityEvent, type ResponsibilityEvent } from './notifications';

type Db = { from:(table:string)=>any };

/** Idempotent cross-domain notification fan-out using existing notification fields. */
export async function notifyResponsibilityEvent(db: Db, input: {
  orderId:string; event:ResponsibilityEvent; sourceId:string; title:string; message:string; fallbackRoles?:string[];
}): Promise<number> {
  const responsibilities = await getEffectiveResponsibilities(db as any,input.orderId);
  const recipients = recipientsForResponsibilityEvent(input.event,responsibilities);
  const fallbackRoles=[...new Set([...(MANAGER_FALLBACK_ROLES[input.event]||[]),...(input.fallbackRoles||[])])];
  if(fallbackRoles.length){
    const {data:profiles}=await db.from('profiles').select('user_id,role,roles,active');
    for(const profile of profiles||[]){
      const roles=Array.isArray(profile.roles)&&profile.roles.length?profile.roles:[profile.role].filter(Boolean);
      if(profile.active!==false&&roles.some((role:string)=>fallbackRoles.includes(role))) recipients.push(profile.user_id);
    }
  }
  const uniqueRecipients=[...new Set(recipients.filter(Boolean))];
  let inserted=0;
  const type=`responsibility:${input.event}:${input.sourceId}`.slice(0,120);
  for(const userId of uniqueRecipients){
    const {data:existing}=await db.from('notifications').select('id').eq('user_id',userId).eq('type',type).eq('related_order_id',input.orderId).limit(1);
    if((existing||[]).length) continue;
    const {error}=await db.from('notifications').insert({user_id:userId,type,title:input.title,message:input.message,related_order_id:input.orderId,status:'unread',email_sent:false});
    if(!error) inserted++;
  }
  return inserted;
}
