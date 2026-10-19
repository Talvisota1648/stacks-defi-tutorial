import math
import uuid

def inside(point,polygon):
    x,y=point;result=False
    for i in range(len(polygon)):
        x1,y1=polygon[i-1];x2,y2=polygon[i]
        if (y1>y)!=(y2>y) and x<(x2-x1)*(y-y1)/(y2-y1)+x1:result=not result
    return result

def evaluate(rules,state,detections,timestamp,max_gap):
    """Light centroid association, not identity recognition or calibrated motion measurement."""
    outputs=[];cooldowns=dict(state.get('_cooldowns',{}));new_state={}
    for rule in rules:
        tracks=[dict(t) for t in state.get(rule['id'],[]) if 0<=timestamp-t['last_seen']<=max_gap]
        used=set()
        for detection in detections:
            if rule['type']=='vehicle_dwell' and detection['label'] not in ('car','bus','truck','motorcycle'):continue
            if rule['type']=='person_zone' and detection['label']!='person':continue
            box=detection['bbox'];point=[(box[0]+box[2])/2,box[3]]
            if not inside(point,rule['polygon']):continue
            candidates=[(math.dist(point,t['point']),i,t) for i,t in enumerate(tracks) if i not in used and t['label']==detection['label']]
            match=min(candidates,key=lambda t:t[0]) if candidates else None
            if match and match[0]<0.06:
                _,index,track=match;used.add(index)
                if rule['type']=='vehicle_dwell' and math.dist(point,track['anchor'])>0.035:
                    track['first_seen']=timestamp;track['anchor']=point
                track['last_seen']=timestamp;track['point']=point
            else:
                track={'id':str(uuid.uuid4()),'label':detection['label'],'first_seen':timestamp,'last_seen':timestamp,'point':point,'anchor':point,'last_event':None}
                tracks.append(track);used.add(len(tracks)-1)
            if timestamp-track['first_seen']>=rule['dwell_seconds'] and track['last_event'] is None and timestamp-cooldowns.get(rule['id'],-1e20)>=rule['cooldown_seconds']:
                track['last_event']=timestamp;cooldowns[rule['id']]=timestamp
                outputs.append({'rule_id':rule['id'],'track_id':track['id'],'category':rule['type'],'detection':detection,'dwell_seconds':timestamp-track['first_seen']})
        # A missed detection breaks continuity; do not claim the object was present in unseen frames.
        new_state[rule['id']]=[t for i,t in enumerate(tracks) if i in used][-30:]
    if cooldowns:new_state['_cooldowns']=cooldowns
    return new_state,outputs
