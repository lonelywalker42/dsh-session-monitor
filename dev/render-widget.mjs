import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.preview');
fs.mkdirSync(output, { recursive: true });
const framework = ['Framework64', 'Framework'].map(name => path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', name, 'v4.0.30319'))
  .find(dir => fs.existsSync(path.join(dir, 'csc.exe')));
if (!framework) throw new Error('Windows .NET Framework compiler required');
const refs = ['System.dll', 'System.Web.Extensions.dll', 'System.Xaml.dll'].map(name => path.join(framework,name));
refs.push(...['PresentationFramework.dll','PresentationCore.dll','WindowsBase.dll'].map(name => path.join(framework,'WPF',name)));
const exe = path.join(output, 'render-widget.exe');
execFileSync(path.join(framework,'csc.exe'), ['/nologo','/codepage:65001','/out:'+exe,...refs.map(ref=>'/r:'+ref),path.join(root,'dev/render-widget.cs')], {stdio:'inherit'});
execFileSync(exe, [path.join(root,'widget/onair-widget.exe'),path.join(output,'widget.png')], {stdio:'inherit'});
