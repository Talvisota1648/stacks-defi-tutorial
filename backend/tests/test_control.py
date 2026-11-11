import socket
from pathlib import Path
import pytest
from osc.control import ROOT,application_process,require_free_port

def test_conda_next_symlink_process_is_recognized_without_matching_other_apps():
    args=['/workspace/miniforge3/envs/osc/bin/node',str(ROOT/'frontend/node_modules/.bin/next'),'start','--hostname','127.0.0.1','--port','3000']
    assert application_process(ROOT/'frontend',args)
    assert not application_process(Path('/unrelated-project'),args)
    assert not application_process(ROOT/'frontend',['node','unrelated.js'])
    assert not application_process(ROOT/'backend',['python','-m','osc.control','restart'])
    assert application_process(ROOT/'backend',['python','-m','osc.run','worker'])
    assert application_process(ROOT/'frontend',['next-server (v15.5.29)'])

def test_existing_listener_cannot_be_mistaken_for_a_new_healthy_service():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));listener.listen()
        with pytest.raises(SystemExit,match='already occupied'):
            require_free_port('0.0.0.0',listener.getsockname()[1])

def test_closed_connection_time_wait_does_not_block_restart():
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        listener.bind(('127.0.0.1',0));listener.listen()
        port=listener.getsockname()[1]
        with socket.create_connection(('127.0.0.1',port)) as client:
            connection,_=listener.accept()
            connection.close()
            assert client.recv(1)==b''
    require_free_port('127.0.0.1',port)
