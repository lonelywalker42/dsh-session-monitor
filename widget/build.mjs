// node widget/build.mjs — Windows/.NET Framework 4.8, no external dependencies.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const windows = process.env.WINDIR || 'C:/Windows';
const framework = ['Framework64', 'Framework'].map(name => path.join(windows, 'Microsoft.NET', name, 'v4.0.30319'))
  .find(root => existsSync(path.join(root, 'csc.exe')));
if (!framework) throw new Error('需要 Windows .NET Framework 4.x 编译器');
const references = ['System.dll', 'System.Web.Extensions.dll', 'System.Xaml.dll'].map(name => path.join(framework, name));
references.push(...['PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll'].map(name => path.join(framework, 'WPF', name)));
execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:winexe', '/out:' + path.join(dir, 'onair-widget.exe'),
  ...references.map(ref => '/r:' + ref), '/resource:' + path.join(dir, 'onair-widget.xaml') + ',DshOnAir.onair-widget.xaml',
  path.join(dir, 'glass-window.cs'), path.join(dir, 'onair-widget.cs')], { stdio: 'inherit' });
console.log('Built widget/onair-widget.exe (layout embedded; optional external XAML supported).');

const hash = file => createHash('sha256').update(readFileSync(path.join(dir,file))).digest('hex');
let gitCommit=null; try {gitCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim()} catch {}
const sources=Object.fromEntries(['onair-widget.cs','glass-window.cs','onair-widget.xaml','onair-widget.ps1','build.mjs'].map(file=>[file,hash(file)]));
writeFileSync(path.join(dir,'build-manifest.json'),JSON.stringify({schemaVersion:1,version:JSON.parse(readFileSync(path.join(dir,'../package.json'))).version,gitCommit,sources,exeSha256:hash('onair-widget.exe')},null,2)+'\n');
