from osc.collector import read_segments

def test_only_complete_csv_records_are_queued(tmp_path):
    path=tmp_path/'segments.csv'
    path.write_text('000001.mp4,0.0,5.0\n000002.mp4,5.')
    rows,offset=read_segments(path,0)
    assert rows==[['000001.mp4','0.0','5.0']]
    with path.open('a') as f:f.write('0,10.0\n')
    next_rows,next_offset=read_segments(path,offset)
    assert next_rows==[['000002.mp4','5.0','10.0']]
    assert next_offset==path.stat().st_size
