from osc.rules import evaluate

RULE={'id':'zone','type':'vehicle_dwell','polygon':[[0,0],[1,0],[1,1],[0,1]],'dwell_seconds':3,'cooldown_seconds':30}
CAR={'label':'car','score':.9,'bbox':[.2,.2,.4,.4]}
def test_no_rule_means_no_violation():assert evaluate([],{},[CAR],100,3)==({},[])
def test_stationary_dwell_and_cooldown():
    state={};all_events=[]
    for t in range(10):state,found=evaluate([RULE],state,[CAR],100+t,3);all_events.extend(found)
    assert len(all_events)==1 and all_events[0]['dwell_seconds']==3

def test_normal_movement_and_missing_detections_do_not_accumulate():
    state={};events=[]
    for t in range(6):
        detection={**CAR,'bbox':[.1+t*.08,.2,.3+t*.08,.4]}
        state,found=evaluate([RULE],state,[detection],100+t,3);events.extend(found)
    assert not events
    state,_=evaluate([RULE],{},[CAR],100,3)
    state,_=evaluate([RULE],state,[],101,3)
    state,found=evaluate([RULE],state,[CAR],104,3)
    assert not found

def test_wrong_class_and_outside_zone():
    assert not evaluate([{**RULE,'type':'person_zone'}],{},[CAR],100,3)[1]
    narrow={**RULE,'polygon':[[.7,.7],[1,.7],[1,1],[.7,1]]}
    state,_=evaluate([narrow],{},[CAR],100,3)
    assert not state['zone']

def test_same_continuous_track_is_not_reported_every_cooldown():
    state={};events=[]
    for t in range(100):
        state,found=evaluate([RULE],state,[CAR],100+t,3);events.extend(found)
    assert len(events)==1
