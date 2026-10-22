import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);

describe('actual iTerm2 Python helper title contract', () => {
  it('reads terminalWindowName separately from an overridden autoName', async () => {
    const script = fileURLToPath(new URL('../bin/iterm2-helper.py', import.meta.url));
    const fixture = `
import asyncio,json,runpy,sys,types
class Session:
 session_id='w1t2p3:fixture-pane'
 name='fallback'
 async def async_get_variable(self,key):
  return {'session.autoName':'Friendly tab','session.path':'/fixture','session.terminalWindowName':'native thread-id title'}[key]
async def app(connection):
 return types.SimpleNamespace(windows=[types.SimpleNamespace(tabs=[types.SimpleNamespace(sessions=[Session()])])])
sys.modules['iterm2']=types.SimpleNamespace(async_get_app=app)
helper=runpy.run_path(sys.argv[1])
print(json.dumps(asyncio.run(helper['_list_sessions'](None))))
`;
    const result = await runFile('python3', ['-c', fixture, script], { timeout: 3000 });
    expect(JSON.parse(result.stdout)).toEqual([{ paneId: 'fixture-pane', title: 'Friendly tab',
      cwd: '/fixture', terminalTitle: 'native thread-id title' }]);
  });
});
