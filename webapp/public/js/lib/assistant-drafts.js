// Technical confirmation marker captured atomically with the owning financial write.
// A loaded marker proves the same saved snapshot contains that write; never repeat it.
import {store} from './store.js';
import {conversation,epoch} from './assistant-conversation.js';
const runtime=crypto.randomUUID();
export function draftStatus(message,index){
 const marker=message?.draft_receipts?.[index];
 if(!marker)return 'proposed';
 if(marker.runtime!==runtime||marker.generation!==store.generation()||store.persistenceState().durableRevision>=marker.revision)return 'saved';
 return 'pending';
}
export function nextDraftIndex(message){return (message?.actions||[]).findIndex((_,index)=>!message.draft_skipped?.[index]&&draftStatus(message,index)!=='saved');}
export function orderDrafts(actions){return actions.map((action,index)=>({action,index,rank:action.kind==='add_account'?0:action.kind==='create_goal'?1:2})).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(item=>item.action);}
export async function skipDraft(messageId,index,skipped,expected){
 const receipt=store.captureAction(`draft-skip:${messageId}:${index}`,()=>{
 if(epoch()!==expected)throw new Error('Conversation changed.');
 const row=conversation(),message=row.messages.find(m=>m.id===messageId);
 if(!message?.actions?.[index]||draftStatus(message,index)!=='proposed')throw new Error('Only an unconfirmed draft can be skipped or resumed.');
 store.update('conversations',row.id,{messages:row.messages.map(m=>m.id===messageId?{...m,draft_skipped:{...m.draft_skipped,[index]:skipped}}:m)});
 });await store.commit(receipt);
}
export function markDraftConfirmation(messageId,index,expected,action){
 if(epoch()!==expected)throw new Error('Conversation changed. No change saved.');
 const row=conversation(),message=row.messages.find(m=>m.id===messageId);
 if(action&&JSON.stringify(message?.actions?.[index])!==JSON.stringify(action))throw new Error('This draft changed. Review it again.');
 if(index!==nextDraftIndex(message))throw new Error('Review the earlier draft first, or skip it.');
 if(!message?.actions?.[index]||draftStatus(message,index)!=='proposed')throw new Error('This change is already confirmed. Retry saving only; do not repeat the change.');
 const marker={runtime,generation:store.generation(),revision:store.persistenceState().revision+1};
 store.update('conversations',row.id,{messages:row.messages.map(m=>m.id===messageId?{...m,draft_receipts:{...m.draft_receipts,[index]:marker}}:m)});
}
export async function retryDraftPersistence(){await store.retryPending();if(store.persistenceState().dirty)throw new Error('Device storage has not confirmed saving. Keep this screen open; do not repeat the financial change.');}
