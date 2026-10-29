import {G0Store} from './store.mjs';
export class TimedG0Store extends G0Store {
  constructor(directory, options={}) {
    super(directory,{participants:['dot','muse'],maxMessages:64,...options});
    this.data.conversation ||= {armed_at:null,started_at:null,deadline:null,duration_seconds:600};
    if(!this.data.conversation.started_at && this.data.messages.length){
      this.data.conversation.started_at=this.data.messages[0].at;
      this.data.conversation.deadline=new Date(Date.parse(this.data.messages[0].at)+600000).toISOString();
    }
    this.persist();
  }
  conversationClosed() {
    const c=this.data.conversation;
    return this.data.revoked || this.now()>=this.data.expires || this.data.messages.length>=this.data.max_messages ||
      Boolean(c.deadline && this.now()>=Date.parse(c.deadline)) ||
      Boolean(c.armed_at && !c.started_at && this.now()>=Date.parse(c.arm_expires_at));
  }
  startConversation(durationSeconds=600,maxMessages=64) {
    if(durationSeconds!==600 || !Number.isInteger(maxMessages) || maxMessages<2 || maxMessages>64)throw new Error('This test allows exactly 600 seconds and at most 64 messages');
    if(this.data.revoked || this.now()>=this.data.expires)throw new Error('Experiment closed');
    if(this.data.conversation.armed_at)throw new Error('Already armed; the window cannot be extended');
    if(!this.data.participants.every(r=>this.data.registrations[r]?.status==='claimed'))throw new Error('Both identities must be claimed');
    if(this.data.require_reconfirmation && !this.data.participants.every(r=>this.data.registrations[r]?.reconfirmed_run_id===this.data.run_id))throw new Error('Both clients must complete authenticated preflight before arming');
    this.data.max_messages=Math.min(this.data.max_messages,maxMessages);
    this.data.conversation={armed_at:new Date(this.now()).toISOString(),arm_expires_at:new Date(this.now()+180000).toISOString(),started_at:null,deadline:null,duration_seconds:600};
    this.record('owner','armed_ten_minute_conversation');return this.status();
  }
  status() {
    return {...super.status(),mode:'agent_hub_g0_timed',conversation:this.data.conversation,conversation_closed:this.conversationClosed(),native_task_id:this.data.native_task_id || null,
      reconfirmed:Object.fromEntries(this.data.participants.map(r=>[r,this.data.registrations[r]?.reconfirmed_run_id===this.data.run_id])),
      note:'The 600-second send window starts with the first accepted Dot ciphertext. After closure, reads are allowed for final receipt verification; new messages are rejected.'};
  }
  identity(role) {return {...super.identity(role),mode:'agent_hub_g0_timed',conversation:this.data.conversation,conversation_closed:this.conversationClosed()};}
  send(role,args) {
    let envelope;try{envelope=JSON.parse(args.text)}catch{return super.send(role,args)}
    if(envelope.op!=='message')return super.send(role,args);
    if(!this.data.conversation.armed_at)throw new Error('Owner has not armed the timed conversation');
    if(this.conversationClosed())throw new Error('Timed conversation closed; no further sends');
    const previous=this.data.messages.find(m=>m.id===envelope.payload?.id || (m.from===role && m.idempotency_key===args.idempotency_key));
    if(previous)return super.send(role,args);
    const last=this.data.messages.at(-1);
    if(!last && (role!=='dot' || envelope.payload?.reply_to!==null))throw new Error('Dot must open with no reply reference');
    if(last && (last.from===role || envelope.payload?.reply_to!==last.id))throw new Error('Alternate senders and reply to the latest peer message');
    const result=super.send(role,args);
    if(!this.data.conversation.started_at){
      const acceptedAt=this.data.messages[0].at;
      this.data.conversation.started_at=acceptedAt;
      this.data.conversation.deadline=new Date(Date.parse(acceptedAt)+600000).toISOString();
      this.record('owner','ten_minute_window_started');
    }
    return {...result,conversation:this.data.conversation,conversation_closed:this.conversationClosed()};
  }
  inbox(role,after=0) {return {...super.inbox(role,after),conversation:this.data.conversation,conversation_closed:this.conversationClosed()};}
}
