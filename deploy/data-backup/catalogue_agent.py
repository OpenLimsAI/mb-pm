#!/usr/bin/env python3
"""Passive private backup catalogue: inspect metadata and explicitly delete selected archives only."""
from __future__ import annotations
import argparse
import ast
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import signal
import sqlite3
import stat
import subprocess
import threading
import time
import uuid
from zoneinfo import TZPATH, ZoneInfo

UTC = dt.timezone.utc
NAME = re.compile(r'maibo-(\d{8}T\d{6}Z)\.tar\.gz\.gpg\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')
MAX_BODY = 65536
ERRORS = {'invalid_request':'请求参数无效','unauthorized':'请求认证失败','replay':'请求已使用，请重试','rate_limited':'请求过于频繁','revision_conflict':'备份清单已变化，请刷新','request_conflict':'请求标识已用于其他操作','archive_changed':'备份文件已变化，请刷新','protected':'选中的备份受到保护，不能删除','backup_busy':'备份或发布正在进行，请稍后重试','selection_changed':'所选备份已变化，请重新预览','expired_request':'删除预览已过期，请重新确认','operation_failed':'操作未完成，请查看删除记录'}
DB_NAMES = {'mb-pm-v2-pms-db-1':'项目管理数据库','mb-pm-v2-iam-db-1':'统一身份数据库','dikw-postgres':'知识库数据库','cmab-mdm-maibo-postgres-1':'主数据数据库'}
APP_NAMES = {'mb-pm-v2-app-1':'项目管理','mb-pm-v2-app-direct-1':'项目管理','dikw-core':'知识库 Core','dikw-mbweb':'知识库应用','dikw-web':'知识库中台','mb-pm-v2-casdoor-1':'统一身份','mb-pm-v2-direct-proxy-1':'访问代理','iam-proxy':'身份代理','dikw-caddy':'知识库代理','cmab-mdm-maibo-web-1':'主数据管理','cmab-mdm-maibo-backend-1':'主数据管理','cmab-mdm-maibo-redis-1':'主数据缓存'}

class Error(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)

def compact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def stamp(value=None):
    return dt.datetime.fromtimestamp(time.time() if value is None else value, UTC).isoformat()

def private(value, directory=False, trusted=False, catalogue_root=False):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Unsafe configured path')
    info = path.stat()
    if info.st_uid not in ({os.geteuid(), 0} if trusted else {os.geteuid()}) or info.st_mode & (0o002 if catalogue_root else 0o022 if trusted else 0o077):
        raise ValueError('Unsafe configured permissions')
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('Unsafe configured type')
    return path

def config_read(filename):
    path = private(filename)
    if path.stat().st_size > MAX_BODY: raise ValueError('Configuration too large')
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or set(data) - {'bind','port','secretFile','stateDirectory','keyFile','roots','lockDirectory','planScript','requestsPerMinute'}:
        raise ValueError('Unknown configuration')
    for key in ('secretFile','keyFile'): data[key] = private(data[key])
    for key in ('stateDirectory','lockDirectory'): data[key] = private(data[key], directory=True)
    data['planScript'] = private(data['planScript'], trusted=True)
    if data['secretFile'].stat().st_size > 4096: raise ValueError('Secret size')
    data['secret'] = data['secretFile'].read_bytes().strip()
    if len(data['secret']) < 32: raise ValueError('Secret too short')
    address = ipaddress.ip_address(data.setdefault('bind','127.0.0.1'))
    if address.version != 4 or not(address.is_private or address.is_loopback) or address.is_unspecified or address.is_multicast or address.is_link_local:
        raise ValueError('Explicit private address required')
    for key, default, low, high in (('port',18941,1024,65535),('requestsPerMinute',120,10,600)):
        data.setdefault(key,default)
        if type(data[key]) is not int or not low <= data[key] <= high: raise ValueError('Invalid numeric configuration')
    roots = data.get('roots')
    if not isinstance(roots,list) or not 1 <= len(roots) <= 20: raise ValueError('Explicit roots required')
    seen=set(); paths=[]
    for root in roots:
        if not isinstance(root,dict) or set(root) != {'id','label','path'} or not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',root['id']) or root['id'] in seen or not isinstance(root['label'],str) or not 1 <= len(root['label']) <= 80 or any(ord(c)<32 for c in root['label']): raise ValueError('Invalid root')
        seen.add(root['id']); root['path'] = private(root['path'],directory=True,trusted=True,catalogue_root=True)
        if any(root['path'].is_relative_to(other) or other.is_relative_to(root['path']) for other in paths) or data['stateDirectory'].is_relative_to(root['path']) or root['path'].is_relative_to(data['stateDirectory']): raise ValueError('Roots must not overlap')
        paths.append(root['path']); info=root['path'].stat(); root['identity']=(info.st_dev,info.st_ino)
    return data

def archive_family(name):
    # Keep unknown backup families distinct; remove only explicit timestamp/hash suffixes.
    value=re.sub(r'(?<![0-9])20[0-9]{2}[-_]?[01][0-9][-_]?[0-3][0-9](?:[T_-]?[0-2][0-9][:_-]?[0-5][0-9](?:[:_-]?[0-5][0-9])?Z?)?(?![0-9])','{date}',name.lower())
    value=re.sub(r'[-_][0-9a-f]{7,64}(?=\.(?:tgz|dump|sql|tar))','-{hash}',value)
    return value

def actor_valid(actor):
    return isinstance(actor,str) and 0<len(actor)<=255 and not any(ord(c)<32 for c in actor)

def identity(info):
    return [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_nlink,info.st_ctime_ns]

class Store:
    def __init__(self,path):
        self.path=path
        for file in (path,Path(str(path)+'-wal'),Path(str(path)+'-shm')):
            if file.exists() or file.is_symlink(): private(file)
        with self.connect() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY,identity TEXT NOT NULL,status TEXT NOT NULL,contents TEXT NOT NULL,full INTEGER NOT NULL,verified REAL,sha TEXT);
CREATE TABLE IF NOT EXISTS previews(token TEXT PRIMARY KEY,actor TEXT NOT NULL,revision TEXT NOT NULL,items TEXT NOT NULL,expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS deletions(id TEXT PRIMARY KEY,actor TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,created REAL NOT NULL,status TEXT NOT NULL,count INTEGER NOT NULL,bytes INTEGER NOT NULL,error TEXT,UNIQUE(actor,request_id));''')
        path.chmod(0o600)
        with self.connect() as db:
            if 'items' not in {row[1] for row in db.execute('PRAGMA table_info(deletions)')}:
                db.execute("ALTER TABLE deletions ADD COLUMN items TEXT NOT NULL DEFAULT '[]'")
        # A process can be killed between unlink and receipt update. Never silently replay that request.
        with self.connect() as db: db.execute("UPDATE deletions SET status='partial',error='operation_failed' WHERE status='running'")
    @contextmanager
    def connect(self):
        db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row
        try:
            with db: yield db
        finally: db.close()
    def nonce(self,value,now,limit):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE');db.execute('DELETE FROM nonces WHERE created<?',(now-120,))
            if db.execute('SELECT 1 FROM nonces WHERE nonce=?',(value,)).fetchone(): raise Error('replay',409)
            if db.execute('SELECT COUNT(*) FROM nonces WHERE created>?',(now-60,)).fetchone()[0]>=limit: raise Error('rate_limited',429)
            db.execute('INSERT INTO nonces VALUES (?,?)',(value,now))
    def scan(self,item):
        with self.connect() as db: row=db.execute('SELECT * FROM scans WHERE id=? AND identity=?',(item['id'],compact(item['identity']))).fetchone()
        return dict(row) if row else None
    def save_scan(self,item,status,contents,full=False,sha=None):
        with self.connect() as db: db.execute('INSERT OR REPLACE INTO scans VALUES (?,?,?,?,?,?,?)',(item['id'],compact(item['identity']),status,compact(contents),int(full),time.time() if status=='verified' else None,sha))

@contextmanager
def locks(directory):
    handles=[]
    try:
        for name in ('.daily-backup.lock','.backup.lock'):
            fd=os.open(directory/name,os.O_RDWR|os.O_NOFOLLOW); handles.append(fd)
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077: raise Error('backup_busy',409)
            try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise Error('backup_busy',409) from None
        yield
    except FileNotFoundError: raise Error('backup_busy',409) from None
    finally:
        for fd in reversed(handles): os.close(fd)

def opened(root,relative):
    parts=PurePosixPath(relative).parts
    if not parts or any(part in ('..','.') for part in parts) or PurePosixPath(relative).is_absolute(): raise Error('archive_changed',409)
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);os.close(directory);directory=next_fd
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
        return directory,fd,parts[-1]
    except Exception:
        os.close(directory);raise


def content_manifest(manifest, hashes):
    if not isinstance(manifest,dict) or not isinstance(manifest.get('sha256'),dict): return [],False,'unknown'
    expected=manifest['sha256']
    if set(expected)!=set(hashes) or any(not HEX.fullmatch(str(value)) or hashes[name]!=value for name,value in expected.items()): raise ValueError('Manifest checksum mismatch')
    rows,mounts=manifest.get('databases'),manifest.get('mounts')
    if not isinstance(rows,list) or not isinstance(mounts,list): return [],False,'unknown'
    contents=[];databases=set();applications=set();listed={'runtime-inspect.json'}
    for row in rows:
        if not isinstance(row,dict) or row.get('file') not in hashes or not isinstance(row.get('database'),str) or row['file']!=row['database']+'.dump': raise ValueError('Invalid database record')
        if row['file'] in listed: raise ValueError('Duplicate database')
        listed.add(row['file']); container=row.get('container');databases.add(container)
        contents.append({'name':DB_NAMES.get(container,'其他数据库'),'kind':'database','detail':'归档清单记录的数据库逻辑备份，内容摘要已核验'})
    for mount in mounts:
        if not isinstance(mount,dict) or not re.fullmatch(r'mount-[0-9]+\.tar',str(mount.get('file'))) or mount['file'] not in hashes or mount['file'] in listed: raise ValueError('Invalid mount record')
        listed.add(mount['file']); app=mount.get('container');applications.add(app)
        title=APP_NAMES.get(app,'其他持久文件')
        if not any(c['name']==title and c['kind']=='files' for c in contents): contents.append({'name':title,'kind':'files','detail':'归档清单记录的持久文件，内容摘要已核验'})
    if 'config-files.tar' in hashes:
        listed.add('config-files.tar');contents.append({'name':'运行配置','kind':'configuration','detail':'加密保存的运行配置，浏览器不读取配置内容'})
    if 'runtime-inspect.json' not in hashes or listed!=set(hashes): return contents,False,'unknown'
    full={('mb-pm-v2-pms-db-1','mb_pm'),('mb-pm-v2-iam-db-1','casdoor'),('dikw-postgres','dikw')}.issubset({(r.get('container'),r.get('database')) for r in rows}) and {'dikw-core','dikw-mbweb'}.issubset(applications) and 'config-files.tar' in hashes and manifest.get('consistency')=='all application writers stopped; PostgreSQL logical dumps'
    return contents,full,'verified'


def parse_tar(stream):
    import tarfile
    hashes={};manifest=None;total=0;seen=set()
    with tarfile.open(fileobj=stream,mode='r|gz') as archive:
        for number,member in enumerate(archive):
            if number>10000 or member.size<0: raise ValueError('Archive limit')
            name=member.name.removeprefix('./');path=PurePosixPath(name)
            if name in ('','.') and member.isdir(): continue
            if not member.isfile() or len(path.parts)!=1 or path.name in ('.','..') or '\\' in name or name in seen: raise ValueError('Invalid payload path')
            seen.add(name);total+=member.size
            if total>64*1024**3: raise ValueError('Archive limit')
            digest=hashlib.sha256();record=bytearray();file=archive.extractfile(member)
            for chunk in iter(lambda:file.read(1024*1024),b''):
                digest.update(chunk)
                if name=='manifest.json':
                    if len(record)+len(chunk)>2*1024**2: raise ValueError('Manifest limit')
                    record.extend(chunk)
            if name=='manifest.json': manifest=json.loads(record)
            else: hashes[name]=digest.hexdigest()
    return content_manifest(manifest,hashes)


def scan_archive(config,item):
    directory,fd,_=opened(item['_root'],item['_relative'])
    try:
        if identity(os.fstat(fd))!=item['identity']: raise Error('archive_changed',409)
        with os.fdopen(os.dup(fd),'rb') as source:
            process=subprocess.Popen(['gpg','--batch','--no-tty','--pinentry-mode','loopback','--passphrase-file',str(config['keyFile']),'--decrypt'],stdin=source,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={**os.environ,'GNUPGHOME':str(config['stateDirectory']/'gnupg')})
            expired=threading.Event()
            def timeout():
                expired.set()
                try: process.kill()
                except ProcessLookupError: pass
            timer=threading.Timer(300,timeout);timer.start()
            try:
                result=parse_tar(process.stdout)
                # Consume to EOF so GPG can authenticate MDC/AEAD after the archive's last member.
                while process.stdout.read(1024*1024): pass
                if process.wait(timeout=10)!=0 or expired.is_set(): raise ValueError('Authentication failed')
            finally:
                timer.cancel();process.stdout.close()
                if process.poll() is None: process.kill()
                process.wait(timeout=10)
        if identity(os.fstat(fd))!=item['identity']: raise Error('archive_changed',409)
        os.lseek(fd,0,os.SEEK_SET);digest=hashlib.sha256()
        for chunk in iter(lambda:os.read(fd,1024*1024),b''): digest.update(chunk)
        return *result,digest.hexdigest()
    finally: os.close(fd);os.close(directory)


def timezone_read():
    # Cron follows the host's /etc/localtime. Debian's /etc/timezone can remain
    # stale after timedatectl changes the zone, so it must not take precedence.
    localtime=Path('/etc/localtime');roots=[Path(path) for path in TZPATH]
    try:
        target=localtime.resolve(strict=True)
        for root in roots:
            try: value=target.relative_to(root.resolve()).as_posix()
            except ValueError: continue
            if len(value)>80: continue
            ZoneInfo(value);return value
    except (OSError,RuntimeError,ValueError,KeyError): pass
    try: data=localtime.read_bytes() if localtime.stat().st_size<=128*1024 else None
    except OSError: data=None
    def confirmed(value,require_match=False):
        if not value or len(value)>80: return None
        ZoneInfo(value)
        if data is None: return None if require_match else value
        for root in roots:
            try:
                path=root/value
                if path.stat().st_size==len(data) and path.read_bytes()==data: return value
            except OSError: continue
        return None
    try:
        value=subprocess.run(['timedatectl','show','--property=Timezone','--value'],capture_output=True,text=True,timeout=5,check=True).stdout.strip()
        value=confirmed(value)
        if value: return value
    except (OSError,ValueError,KeyError,subprocess.SubprocessError): pass
    try:
        value=confirmed(Path('/etc/timezone').read_text().strip(),require_match=True)
        if value: return value
    except (OSError,ValueError,KeyError): pass
    return 'unknown'

def retention_read(script):
    try:
        tree=ast.parse(script.read_text());days=set();counts=set()
        for node in ast.walk(tree):
            if isinstance(node,ast.keyword) and node.arg=='days' and isinstance(node.value,ast.Constant) and type(node.value.value)is int: days.add(node.value.value)
            if isinstance(node,ast.Slice) and node.lower is None and isinstance(node.upper,ast.Constant) and type(node.upper.value)is int: counts.add(node.upper.value)
        if len(days)==len(counts)==1 and 1<=next(iter(days))<=365 and 1<=next(iter(counts))<=365: return f'现有脚本同时保留最近 {next(iter(counts))} 份及至少 {next(iter(days))} 天；本应用不修改保留规则'
    except (OSError,ValueError,SyntaxError): pass
    return '未能可靠解析现有保留规则；本应用不修改规则'

def plan_read(config):
    zone=timezone_read();status='unknown';summary='暂时无法读取现有自动备份计划'
    try:
        result=subprocess.run(['crontab','-l'],capture_output=True,text=True,timeout=5)
        if len(result.stdout)>1024**2: raise ValueError()
        entries=[];tz=zone
        for line in result.stdout.splitlines():
            line=line.strip()
            if not line or line.startswith('#'): continue
            if line.startswith('CRON_TZ='):
                value=line.partition('=')[2].strip('"\'');ZoneInfo(value);tz=value;continue
            if re.match(r'[A-Za-z_][A-Za-z0-9_]*=',line): continue
            tokens=shlex.split(line)
            if not any(Path(token).name=='daily_backup.py' for token in tokens): continue
            command=tokens[1:] if tokens and tokens[0].startswith('@') else tokens[5:]
            matches=bool(command) and (command[0]==str(config['planScript']) or len(command)>1 and re.fullmatch(r'python(?:3(?:\.[0-9]+)?)?',Path(command[0]).name) and command[1]==str(config['planScript']))
            entries.append((tokens,matches,tz))
        if result.returncode==1 and not result.stdout.strip() and 'no crontab for' in result.stderr.lower(): status,summary='disabled','当前用户没有启用的备份 cron 计划'
        elif result.returncode!=0: pass
        elif len(entries)>1: status,summary='conflict','发现多条每日备份计划，请管理员核对；本应用不会修改它们'
        elif not entries: status,summary='disabled','未发现对应的自动备份计划'
        elif not entries[0][1]: status,summary='unknown','存在其他备份脚本，需管理员核对'
        else:
            tokens,_,zone=entries[0]
            if len(tokens)>=7 and tokens[2:5]==['*','*','*'] and tokens[0].isdigit() and tokens[1].isdigit() and 0<=int(tokens[0])<60 and 0<=int(tokens[1])<24:
                status='active';summary=f'每日 {int(tokens[1]):02d}:{int(tokens[0]):02d} 执行现有自动备份'
            else: status,summary='active','已启用现有自定义 cron 计划'
            if zone=='unknown': status='unknown';summary='发现备份计划，但尚无法确认服务器时区'
    except (OSError,ValueError,KeyError,subprocess.SubprocessError): pass
    return {'status':status,'source':'cron','timezone':zone,'summary':summary,'retentionSummary':retention_read(config['planScript']),'checkedAt':stamp()}

class Catalogue:
    def __init__(self,config):
        self.config=config; self.stop=threading.Event();self.mutex=threading.RLock();self.scanning=None
        (config['stateDirectory']/'gnupg').mkdir(mode=0o700,exist_ok=True);private(config['stateDirectory']/'gnupg',directory=True)
        self.store=Store(config['stateDirectory']/'catalogue.sqlite3')
    def authenticate(self,method,path,headers,body,now=None):
        now=time.time() if now is None else now;ts,nonce,sig=(headers.get(k,'') for k in ('X-Backup-Time','X-Backup-Nonce','X-Backup-Signature'))
        if not re.fullmatch(r'\d{10}',ts) or abs(now-int(ts))>60 or not re.fullmatch(r'[a-f0-9]{32}',nonce) or not HEX.fullmatch(sig): raise Error('unauthorized',401)
        payload='\n'.join((method,path,ts,nonce,hashlib.sha256(body).hexdigest())).encode()
        if not hmac.compare_digest(hmac.new(self.config['secret'],payload,hashlib.sha256).hexdigest(),sig): raise Error('unauthorized',401)
        self.store.nonce(nonce,now,self.config['requestsPerMinute'])
    def inventory(self):
        archives={};roots=[];inodes=set();count=0
        for root in self.config['roots']:
            info=private(root['path'],directory=True,trusted=True,catalogue_root=True).stat()
            if (info.st_dev,info.st_ino)!=root['identity']: raise Error('archive_changed',409)
            logical=physical=other=archive_count=0; unsafe_dirs=set()
            if info.st_mode&0o022: unsafe_dirs.add(root['path'])
            def unreadable_directory(error): raise Error('operation_failed',503)
            for path,dirs,files,fd in os.fwalk(root['path'],follow_symlinks=False,onerror=unreadable_directory):
                if os.fstat(fd).st_mode&0o022: unsafe_dirs.add(Path(path))
                directory_safe=not any(Path(path).is_relative_to(unsafe) for unsafe in unsafe_dirs)
                if len(Path(path).relative_to(root['path']).parts)>30: raise Error('operation_failed',503)
                for name in files:
                    count+=1
                    if count>200000: raise Error('operation_failed',503)
                    try: info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    except FileNotFoundError: continue
                    if not stat.S_ISREG(info.st_mode): continue
                    allocated=getattr(info,'st_blocks',0)*512;unique=(info.st_dev,info.st_ino) not in inodes
                    inodes.add((info.st_dev,info.st_ino));physical+=allocated if unique else 0;logical+=info.st_size
                    match=NAME.fullmatch(name)
                    try: created=dt.datetime.strptime(match[1],'%Y%m%dT%H%M%SZ').replace(tzinfo=UTC) if match else None
                    except ValueError: created=None
                    recognized=created is not None or name.lower().endswith(('.tgz','.sql.gz','.dump','.sql','.tar.gz','.tar'))
                    if not recognized and name.lower().endswith('.backup'):
                        try:
                            peek=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
                            try: recognized=os.read(peek,16)==b'SQLite format 3\x00'
                            finally: os.close(peek)
                        except OSError: pass
                    if not recognized or info.st_size==0:
                        other+=allocated if unique else 0;continue
                    relative=str(Path(path).relative_to(root['path'])/name)
                    identifier=hashlib.sha256((root['id']+'\0'+relative).encode()).hexdigest()
                    archives[identifier]={'id':identifier,'name':name,'rootLabel':root['label'],'createdAt':created.isoformat() if created else None,'_sort':created.timestamp() if created else info.st_mtime,'_gpg':created is not None,'sizeBytes':info.st_size,'diskBytes':allocated,'identity':identity(info),'_root':root['path'],'_relative':relative,'_private':directory_safe and info.st_uid==os.geteuid() and not info.st_mode&0o022}
                    archive_count+=1
            roots.append({'id':root['id'],'label':root['label'],'archiveCount':archive_count,'sizeBytes':logical,'diskBytes':physical,'otherBytes':other})
        return archives,roots
    def catalog(self,check_lock=True):
        items,roots=self.inventory();busy=False
        if check_lock:
            try:
                with locks(self.config['lockDirectory']): pass
            except (Error,OSError): busy=True
        full=[]
        for item in items.values():
            scan=self.store.scan(item)
            item.update(status=scan['status'] if scan else 'pending' if item['_gpg'] else 'unknown',contents=json.loads(scan['contents']) if scan else [],verifiedAt=stamp(scan['verified']) if scan and scan['verified'] else None)
            if scan and scan['status']=='verified' and scan['full'] and item['identity'][4]==1 and item['_private']: full.append(item)
        latest=max(full,key=lambda x:(x['_sort'],x['id']))['id'] if full else None
        families={}
        for item in items.values():
            if not item['_gpg']:
                family=(str(item['_root']), archive_family(item['_relative']))
                if family not in families or (item['_sort'],item['id'])>(families[family]['_sort'],families[family]['id']): families[family]=item
        preserved={item['id'] for item in families.values()}
        for item in items.values():
            reason='备份或发布正在进行' if busy else '当前没有已核验的完整恢复副本' if latest is None else '最新已核验的完整恢复副本' if item['id']==latest else '正在核验该归档' if item['id']==self.scanning or item['status']=='pending' else '存在多个硬链接，禁止删除' if item['identity'][4]!=1 else '文件或目录权限不符合安全删除要求' if not item['_private'] else '该类备份未找到更新的可替代副本' if item['id'] in preserved else None
            item['protected']=reason is not None;item['protectionReason']=reason
        revision=hashlib.sha256(compact([[key,item['identity'],item['status'],item['protected']] for key,item in sorted(items.items())]).encode()).hexdigest()
        return items,roots,revision
    def snapshot(self):
        with self.mutex: items,roots,revision=self.catalog()
        usage=shutil.disk_usage(self.config['lockDirectory'])
        with self.store.connect() as db: receipts=[deletion_out(row) for row in db.execute('SELECT * FROM deletions ORDER BY created DESC LIMIT 100')]
        alerts=[]
        if not any(item['protectionReason']=='最新已核验的完整恢复副本' for item in items.values()): alerts.append('尚未建立已核验的完整恢复副本，删除功能保持保护')
        if len(items)>1000: alerts.append('仅展示最近1000份归档，容量统计包含全部受管理文件')
        return {'connected':True,'generatedAt':stamp(),'catalogRevision':revision,'plan':plan_read(self.config),'storage':{'totalBytes':usage.total,'freeBytes':usage.free,'backupBytes':sum(r['diskBytes'] for r in roots),'archiveBytes':sum(i['sizeBytes'] for i in items.values()),'otherBytes':sum(r['otherBytes'] for r in roots)},'roots':roots,'archives':[{key:value for key,value in item.items() if not key.startswith('_') and key!='identity'} for item in sorted(items.values(),key=lambda x:x['_sort'],reverse=True)[:1000]],'deletions':receipts,'alerts':alerts}
    def preview(self,data):
        if not isinstance(data,dict) or set(data)!={'archiveIds','catalogRevision','actor'} or not actor_valid(data['actor']) or not isinstance(data['archiveIds'],list) or not 1<=len(data['archiveIds'])<=100 or any(not isinstance(i,str) or not HEX.fullmatch(i) for i in data['archiveIds']) or len(set(data['archiveIds']))!=len(data['archiveIds']): raise Error('invalid_request')
        with self.mutex, locks(self.config['lockDirectory']):
            items,_,revision=self.catalog(check_lock=False)
            if data['catalogRevision']!=revision: raise Error('revision_conflict',409)
            chosen=[]
            for identifier in data['archiveIds']:
                item=items.get(identifier)
                if not item: raise Error('selection_changed',409)
                if item['protected']: raise Error('protected',409)
                chosen.append(item)
            token=secrets.token_urlsafe(32);expires=time.time()+300
            with self.store.connect() as db:
                db.execute('DELETE FROM previews WHERE expires<?',(time.time(),))
                db.execute('INSERT INTO previews VALUES (?,?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),data['actor'],revision,compact([{key:item[key] for key in ('id','identity')} for item in chosen]),expires))
            return {'token':token,'itemCount':len(chosen),'sizeBytes':sum(i['sizeBytes'] for i in chosen),'diskBytes':sum(i['diskBytes'] for i in chosen),'items':[{key:item[key] for key in ('id','name','rootLabel','sizeBytes','diskBytes')} for item in chosen],'expiresAt':stamp(expires)}
    def delete(self,data):
        if not isinstance(data,dict) or set(data)!={'token','confirmation','requestId','actor'} or not actor_valid(data['actor']) or not isinstance(data['token'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',data['token']): raise Error('invalid_request')
        try: request_id=str(uuid.UUID(data['requestId']))
        except (ValueError,TypeError,AttributeError): raise Error('invalid_request') from None
        digest=hashlib.sha256(compact({'token':data['token'],'confirmation':data['confirmation']}).encode()).hexdigest()
        with self.mutex:
            with self.store.connect() as db:
                previous=db.execute('SELECT * FROM deletions WHERE actor=? AND request_id=?',(data['actor'],request_id)).fetchone()
                if previous:
                    if previous['payload_hash']!=digest: raise Error('request_conflict',409)
                    return deletion_out(previous)
                preview=db.execute('SELECT * FROM previews WHERE token=? AND actor=?',(hashlib.sha256(data['token'].encode()).hexdigest(),data['actor'])).fetchone()
            if not preview or preview['expires']<time.time(): raise Error('expired_request',409)
            selected=json.loads(preview['items'])
            if data['confirmation']!=f'删除 {len(selected)} 份备份': raise Error('invalid_request')
            with locks(self.config['lockDirectory']):
                items,_,revision=self.catalog(check_lock=False)
                if revision!=preview['revision']: raise Error('revision_conflict',409)
                handles=[]
                try:
                    for choice in selected:
                        item=items.get(choice['id'])
                        if not item or item['identity']!=choice['identity']: raise Error('archive_changed',409)
                        if item['protected']: raise Error('protected',409)
                        directory,fd,name=opened(item['_root'],item['_relative']);handles.append((directory,fd,name,item))
                        info=os.fstat(fd)
                        if identity(info)!=item['identity'] or not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise Error('archive_changed',409)
                    identifier=uuid.uuid4().hex;count=freed=0;error=None
                    with self.store.connect() as db: db.execute("INSERT INTO deletions (id,actor,request_id,payload_hash,created,status,count,bytes,error,items) VALUES (?,?,?,?,?,'running',0,0,NULL,?)",(identifier,data['actor'],request_id,digest,time.time(),compact([{key:item[key] for key in ('id','name','rootLabel','identity')} for _,_,_,item in handles])))
                    try:
                        for directory,fd,name,item in handles:
                            if identity(os.stat(name,dir_fd=directory,follow_symlinks=False))!=item['identity']: raise Error('archive_changed',409)
                            os.unlink(name,dir_fd=directory);count+=1;freed+=item['diskBytes']
                            with self.store.connect() as db: db.execute('UPDATE deletions SET count=?,bytes=? WHERE id=?',(count,freed,identifier))
                    except (OSError,Error): error='operation_failed'
                    status='succeeded' if error is None else 'partial' if count else 'failed'
                    with self.store.connect() as db:
                        db.execute('UPDATE deletions SET status=?,count=?,bytes=?,error=? WHERE id=?',(status,count,freed,error,identifier));db.execute('DELETE FROM previews WHERE token=?',(preview['token'],))
                        return deletion_out(db.execute('SELECT * FROM deletions WHERE id=?',(identifier,)).fetchone())
                finally:
                    for directory,fd,_,_ in handles: os.close(fd);os.close(directory)
    def scan_once(self):
        with self.mutex:
            items,_=self.inventory();item=next((i for i in sorted(items.values(),key=lambda x:x['_sort'],reverse=True) if i['_gpg'] and self.store.scan(i) is None and i['_private'] and i['identity'][4]==1),None)
            if not item: return False
            self.scanning=item['id']
        try:
            contents,full,status,sha=scan_archive(self.config,item)
            with self.mutex:
                current=self.inventory()[0].get(item['id'])
                if current and current['identity']==item['identity']: self.store.save_scan(item,status,contents,full,sha)
        except Exception:
            with self.mutex:
                current=self.inventory()[0].get(item['id'])
                if current and current['identity']==item['identity']: self.store.save_scan(item,'unreadable',[])
        finally:
            with self.mutex: self.scanning=None
        return True
    def worker(self):
        while not self.stop.is_set():
            try:
                if self.scan_once(): continue
            except Exception: pass
            self.stop.wait(30)

def deletion_out(row):
    return {'id':row['id'],'actor':row['actor'],'createdAt':stamp(row['created']),'status':'partial' if row['status']=='running' else row['status'],'deletedCount':row['count'],'deletedBytes':row['bytes'],'error':row['error'] or ('operation_failed' if row['status']=='running' else None)}

class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,address,app): self.app=app;self.slots=threading.BoundedSemaphore(16);super().__init__(address,Handler)
    def process_request(self,request,address):
        if not self.slots.acquire(False): request.close();return
        try: super().process_request(request,address)
        except Exception: self.slots.release();raise
    def process_request_thread(self,request,address):
        try: super().process_request_thread(request,address)
        finally: self.slots.release()

class Handler(BaseHTTPRequestHandler):
    def setup(self): super().setup();self.connection.settimeout(5)
    def log_message(self,*args): pass
    def reply(self,status,value):
        body=compact(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.send_header('Connection','close');self.end_headers();self.wfile.write(body);self.close_connection=True
    def handle_request(self):
        try:
            if (self.command,self.path) not in {('GET','/v1/snapshot'),('POST','/v1/delete-preview'),('POST','/v1/deletions')} or self.headers.get('Transfer-Encoding'): raise Error('invalid_request')
            lengths=self.headers.get_all('Content-Length',[])
            if len(lengths)>1 or self.command=='POST' and not lengths: raise Error('invalid_request')
            length=lengths[0] if lengths else '0'
            if not re.fullmatch(r'[0-9]{1,6}',length) or int(length)>MAX_BODY: raise Error('invalid_request',413)
            if self.command=='GET' and int(length) or self.command=='POST' and self.headers.get_content_type()!='application/json': raise Error('invalid_request')
            if any(len(self.headers.get_all(k,[]))!=1 for k in ('X-Backup-Time','X-Backup-Nonce','X-Backup-Signature')): raise Error('unauthorized',401)
            body=self.rfile.read(int(length))
            if len(body)!=int(length): raise Error('invalid_request')
            self.server.app.authenticate(self.command,self.path,self.headers,body)
            if self.command=='GET': result=self.server.app.snapshot()
            else:
                def pairs(values):
                    result={}
                    for key,value in values:
                        if key in result: raise ValueError()
                        result[key]=value
                    return result
                try: data=json.loads(body,object_pairs_hook=pairs)
                except (ValueError,UnicodeDecodeError): raise Error('invalid_request') from None
                result=self.server.app.preview(data) if self.path=='/v1/delete-preview' else self.server.app.delete(data)
            self.reply(200,result)
        except Error as exc: self.reply(exc.status,{'error':{'code':exc.code,'message':ERRORS[exc.code]}})
        except (OSError,ValueError,sqlite3.Error,TypeError,KeyError): self.reply(503,{'error':{'code':'operation_failed','message':ERRORS['operation_failed']}})
    do_GET=handle_request
    do_POST=handle_request

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config',required=True,type=Path);args=parser.parse_args();os.umask(0o077)
    config=config_read(args.config);fd=os.open(config['stateDirectory']/'catalogue.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    app=Catalogue(config);server=Server((config['bind'],config['port']),app);thread=threading.Thread(target=app.worker,daemon=True);thread.start()
    def stop(signum,frame): app.stop.set();threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try: server.serve_forever(poll_interval=.25)
    finally: app.stop.set();server.server_close();os.close(fd)

if __name__=='__main__':
    try: main()
    except Exception: raise SystemExit('Backup catalogue failed safe; inspect private configuration') from None
