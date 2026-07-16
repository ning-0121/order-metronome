export function procurementScopeComplete(items:Array<{status?:string;ordered:number;received:number}>):boolean{
  const obligations=items.filter((i)=>!['draft','reviewing','cancelled'].includes(String(i.status||'')));
  return obligations.length>0&&obligations.every((i)=>i.ordered>0&&i.received>=i.ordered);
}
export function logisticsScopeComplete(input:{allTasksDone:boolean;shipmentDone:boolean;evidenceComplete:boolean}):boolean{
  return input.allTasksDone&&input.shipmentDone&&input.evidenceComplete;
}
