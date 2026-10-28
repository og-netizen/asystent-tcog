const fields=['operation','address','date','reference','cargo'];
export function comparePlans(previous,current){
 const warnings=[];if(previous.client_key!==current.client_key)warnings.push('client_changed');if(previous.truck_registration!==current.truck_registration)warnings.push('truck_changed');if(previous.main_reference!==current.main_reference)warnings.push('main_reference_changed');
 const before=previous.stops||[],after=current.stops||[],sequenceChanged=before.length!==after.length||before.some((s,i)=>s.operation!==after[i]?.operation);
 const changes=[];
 if(previous.main_reference!==current.main_reference)changes.push({field:'main_reference',before:previous.main_reference,after:current.main_reference});
 if(sequenceChanged)changes.push({field:'stop_sequence',before,after});
 else for(let i=0;i<before.length;i++)for(const field of fields)if(before[i][field]!==after[i][field])changes.push({stop_index:i,field,before:before[i][field],after:after[i][field]});
 if(previous.driver_message!==current.driver_message)changes.push({field:'driver_message',before:previous.driver_message,after:current.driver_message});
 return {status:warnings.length?'NEEDS_CONTEXT':changes.length?'CHANGED':'UNCHANGED',changes,warnings,comparison_basis:'saved_proposals_not_executed_state',requires_human_review:true,external_writes:false};
}
export async function compareOperations(store,tenant,previousId,currentId){
 if(previousId===currentId)throw Error('AI choose different operations');
 const [p,c]=await Promise.all([store.modelOperation(tenant,previousId),store.modelOperation(tenant,currentId)]);
 if(p?.state!=='DONE'||c?.state!=='DONE')throw Error('AI completed proposals required');
 const [pt,ct]=await Promise.all([store.agentTask(tenant,p.payload.task_id),store.agentTask(tenant,c.payload.task_id)]);
 if(!pt||!ct||pt.source.mailbox!==ct.source.mailbox||pt.source.thread_id!==ct.source.thread_id)throw Error('AI unrelated proposal threads');
 if(!Number.isFinite(Date.parse(pt.source.received_at))||!Number.isFinite(Date.parse(ct.source.received_at)))throw Error('AI missing proposal chronology');
 if(Date.parse(pt.source.received_at)>Date.parse(ct.source.received_at))throw Error('AI reversed proposal chronology');
 return {previous_operation_id:previousId,current_operation_id:currentId,...comparePlans(p.payload.draft,c.payload.draft)};
}
