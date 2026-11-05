"""Synthetic filesystem/crypto-protocol tests; never touches production or Docker."""
import datetime as dt
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch, Mock

SPEC=importlib.util.spec_from_file_location('catalogue_agent',Path(__file__).parents[1]/'catalogue_agent.py')
a=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(a)


def bundle(changes=None, extra=None):
    files={'mb_pm.dump':b'PM synthetic','casdoor.dump':b'IAM synthetic','dikw.dump':b'KB synthetic','mount-01.tar':b'files1','mount-02.tar':b'files2','runtime-inspect.json':b'{"SECRET":"must-not-appear"}','config-files.tar':b'private configuration'}
    manifest={'consistency':'all application writers stopped; PostgreSQL logical dumps','databases':[{'container':c,'database':d,'file':d+'.dump'} for c,d in [('mb-pm-v2-pms-db-1','mb_pm'),('mb-pm-v2-iam-db-1','casdoor'),('dikw-postgres','dikw')]],'mounts':[{'container':'dikw-core','file':'mount-01.tar'},{'container':'dikw-mbweb','file':'mount-02.tar'}],'sha256':{n:hashlib.sha256(v).hexdigest() for n,v in files.items()}}
    if changes: changes(manifest,files)
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as archive:
        for name,data in files.items():
            info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))
        if manifest is not None:
            data=json.dumps(manifest).encode();info=tarfile.TarInfo('manifest.json');info.size=len(data);archive.addfile(info,io.BytesIO(data))
        if extra: extra(archive)
    return out.getvalue()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.old_umask=os.umask(0o077);self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name).resolve()
        for name in ('root','other','state','locks'): (self.base/name).mkdir(mode=0o700)
        for name in ('.daily-backup.lock','.backup.lock'): (self.base/'locks'/name).write_text('')
        (self.base/'secret').write_text('s'*48);(self.base/'key').write_text('synthetic-key')
        (self.base/'daily_backup.py').write_text('cutoff = dt.timedelta(days=14)\nnewest = archives[:14]\n')
        self.raw={'secretFile':str(self.base/'secret'),'keyFile':str(self.base/'key'),'stateDirectory':str(self.base/'state'),'lockDirectory':str(self.base/'locks'),'planScript':str(self.base/'daily_backup.py'),'roots':[{'id':'business','label':'业务备份','path':str(self.base/'root')}]}
        self.path=self.base/'config.json';self.write_config();self.cfg=a.config_read(self.path);self.app=a.Catalogue(self.cfg)
    def tearDown(self): self.tmp.cleanup();os.umask(self.old_umask)
    def write_config(self): self.path.write_text(json.dumps(self.raw));self.path.chmod(0o600)
    def file(self,name,data=b'synthetic archive',root='root'):
        path=self.base/root/name;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);path.write_bytes(data);return path
    def item(self,path): return next(i for i in self.app.inventory()[0].values() if i['_root']/i['_relative']==path)
    def verified(self,name='maibo-20261104T012700Z.tar.gz.gpg',root='root'):
        path=self.file(name,root=root);item=self.item(path);self.app.store.save_scan(item,'verified',[{'name':'项目管理数据库','kind':'database','detail':'已核验'}],True,'a'*64);return path
    def pair(self):
        self.verified();old=self.file('pm-20260101.tar');new=self.file('pm-20260201.tar');os.utime(old,ns=(1,1));os.utime(new,ns=(2,2));return old,new
    def preview(self,*paths,actor='admin'):
        items,_,revision=self.app.catalog();ids=[self.item(p)['id'] for p in paths];return self.app.preview({'archiveIds':ids,'catalogRevision':revision,'actor':actor})
    def request(self,preview,actor='admin'): return {'token':preview['token'],'confirmation':f"删除 {preview['itemCount']} 份备份",'requestId':str(uuid.uuid4()),'actor':actor}
    def code(self,code,fn):
        with self.assertRaises(a.Error) as caught: fn()
        self.assertEqual(code,caught.exception.code)
    def signature(self,method='GET',path='/v1/snapshot',body=b'',now=None,nonce=None):
        now=int(time.time()) if now is None else now;nonce=nonce or uuid.uuid4().hex;ts=str(now)
        payload='\n'.join((method,path,ts,nonce,hashlib.sha256(body).hexdigest())).encode()
        return {'X-Backup-Time':ts,'X-Backup-Nonce':nonce,'X-Backup-Signature':hmac.new(self.cfg['secret'],payload,hashlib.sha256).hexdigest()}


class ConfigurationTests(Fixture):
    def test_private_config_required(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError): a.config_read(self.path)
    def test_symlink_key_rejected(self):
        (self.base/'link').symlink_to(self.base/'key');self.raw['keyFile']=str(self.base/'link');self.write_config()
        with self.assertRaises(ValueError): a.config_read(self.path)
    def test_overlapping_roots_rejected(self):
        self.raw['roots'].append({'id':'duplicate','label':'另一处','path':str(self.base/'root')});self.write_config()
        with self.assertRaises(ValueError): a.config_read(self.path)
    def test_state_inside_root_rejected(self):
        self.raw['roots'][0]['path']=str(self.base);self.write_config()
        with self.assertRaises(ValueError): a.config_read(self.path)
    def test_public_and_wildcard_bind_rejected(self):
        for value in ('0.0.0.0','8.8.8.8','::1','169.254.1.1'):
            self.raw['bind']=value;self.write_config()
            with self.assertRaises(ValueError): a.config_read(self.path)
    def test_unknown_configuration_rejected(self):
        self.raw['shellCommand']='bad';self.write_config()
        with self.assertRaises(ValueError): a.config_read(self.path)
    def test_group_write_root_can_be_catalogued_but_not_deleted(self):
        old,new=self.pair();(self.base/'root').chmod(0o775);a.config_read(self.path)
        self.assertTrue(all(i['protected'] for i in self.app.catalog()[0].values()))
    def test_world_write_root_rejected(self):
        (self.base/'root').chmod(0o777)
        with self.assertRaises(ValueError): a.config_read(self.path)


class AuthenticationTests(Fixture):
    def test_valid_hmac_and_replay(self):
        headers=self.signature();self.app.authenticate('GET','/v1/snapshot',headers,b'');self.code('replay',lambda:self.app.authenticate('GET','/v1/snapshot',headers,b''))
    def test_replay_survives_store_restart(self):
        headers=self.signature();self.app.authenticate('GET','/v1/snapshot',headers,b'');self.app=a.Catalogue(self.cfg);self.code('replay',lambda:self.app.authenticate('GET','/v1/snapshot',headers,b''))
    def test_body_and_path_bound(self):
        headers=self.signature('POST','/v1/deletions',b'{}')
        self.code('unauthorized',lambda:self.app.authenticate('POST','/v1/deletions',headers,b'{"different":true}'))
        self.code('unauthorized',lambda:self.app.authenticate('POST','/v1/delete-preview',headers,b'{}'))
    def test_old_future_and_invalid_time_rejected(self):
        for seconds in (-61,61):
            headers=self.signature(now=int(time.time())+seconds);self.code('unauthorized',lambda:self.app.authenticate('GET','/v1/snapshot',headers,b''))
    def test_wrong_hmac_is_not_stored(self):
        headers=self.signature();headers['X-Backup-Signature']='0'*64;self.code('unauthorized',lambda:self.app.authenticate('GET','/v1/snapshot',headers,b''))
        with self.app.store.connect() as db: self.assertEqual(db.execute('SELECT COUNT(*) FROM nonces').fetchone()[0],0)
    def test_durable_rate_limit(self):
        self.cfg['requestsPerMinute']=2
        for _ in range(2): self.app.authenticate('GET','/v1/snapshot',self.signature(),b'')
        self.code('rate_limited',lambda:self.app.authenticate('GET','/v1/snapshot',self.signature(),b''))


class InventoryTests(Fixture):
    def test_no_valid_full_protects_everything(self):
        self.file('one.dump');self.assertTrue(all(i['protected'] for i in self.app.catalog()[0].values()))
    def test_unknown_legacy_never_fabricates_contents(self):
        old,new=self.pair();item=self.app.catalog()[0][self.item(old)['id']];self.assertEqual(item['status'],'unknown');self.assertEqual(item['contents'],[]);self.assertFalse(item['protected'])
    def test_latest_per_unknown_family_preserved(self):
        old,new=self.pair();items=self.app.catalog()[0];self.assertTrue(items[self.item(new)['id']]['protected']);self.assertFalse(items[self.item(old)['id']]['protected'])
    def test_unique_other_business_backup_preserved(self):
        self.verified();path=self.file('mdm-only.dump');self.code('protected',lambda:self.preview(path))
    def test_latest_full_preserved_across_roots(self):
        self.raw['roots'].append({'id':'other','label':'另一处备份','path':str(self.base/'other')});self.write_config();self.cfg=a.config_read(self.path);self.app=a.Catalogue(self.cfg)
        old=self.verified('maibo-20261001T000000Z.tar.gz.gpg');new=self.verified(root='other');items=self.app.catalog()[0]
        self.assertFalse(items[self.item(old)['id']]['protected']);self.assertTrue(items[self.item(new)['id']]['protected'])
    def test_pending_full_protected(self):
        self.verified();path=self.file('maibo-20261105T000000Z.tar.gz.gpg');self.code('protected',lambda:self.preview(path))
    def test_group_writable_file_not_trusted(self):
        old,new=self.pair();old.chmod(0o664);self.code('protected',lambda:self.preview(old))
    def test_group_writable_survivor_not_valid_guard(self):
        full=self.verified();full.chmod(0o664);self.file('old.sql');self.assertTrue(all(i['protected'] for i in self.app.catalog()[0].values()))
    def test_group_writable_nested_directory_readonly(self):
        self.verified();path=self.file('nested/a/old.sql');(self.base/'root'/'nested').chmod(0o770);self.assertFalse(self.item(path)['_private'])
    def test_hardlinks_protected_and_disk_deduplicated(self):
        self.verified();path=self.file('a.dump');os.link(path,self.base/'root'/'b.dump');items,roots=self.app.inventory();self.assertEqual(roots[0]['diskBytes'],sum(getattr(p.stat(),'st_blocks',0)*512 for p in [path,self.base/'root'/'maibo-20261104T012700Z.tar.gz.gpg']))
        self.code('protected',lambda:self.preview(path))
    def test_symlink_files_and_directories_not_traversed(self):
        external=self.file('secret.sql',root='other');(self.base/'root'/'link.sql').symlink_to(external);(self.base/'root'/'dir').symlink_to(self.base/'other',target_is_directory=True);self.assertEqual(self.app.inventory()[0],{})
    def test_sqlite_header_recognized_and_other_counted(self):
        self.file('valid.backup',b'SQLite format 3\x00'+b'x'*256);self.file('fake.backup',b'not sqlite');self.file('key.pem',b'private')
        items,roots=self.app.inventory();self.assertEqual(len(items),1);self.assertGreater(roots[0]['otherBytes'],0)
    def test_root_replaced_detected(self):
        (self.base/'root').rename(self.base/'replaced');(self.base/'root').mkdir();self.code('archive_changed',lambda:self.app.inventory())
    def test_filename_timestamp_normalization(self):
        self.assertEqual(a.archive_family('pm-2026-11-01-103022.tar.gz'),a.archive_family('pm-2026-11-04-110011.tar.gz'))
        self.assertNotEqual(a.archive_family('iam-20261101.dump'),a.archive_family('mdm-20261101.dump'))
    def test_snapshot_no_paths_or_secrets(self):
        self.pair()
        with patch.object(a,'plan_read',return_value={}): encoded=json.dumps(self.app.snapshot())
        self.assertNotIn(str(self.base),encoded);self.assertNotIn('synthetic-key',encoded);self.assertNotIn('identity',encoded)


class DeletionTests(Fixture):
    def test_selected_only_deleted_and_exact_private_audit(self):
        old,new=self.pair();pre=self.preview(old);result=self.app.delete(self.request(pre));self.assertEqual(result['status'],'succeeded');self.assertEqual(result['deletedCount'],1);self.assertFalse(old.exists());self.assertTrue(new.exists())
        with self.app.store.connect() as db: row=db.execute('SELECT items FROM deletions').fetchone()
        audit=json.loads(row[0]);self.assertEqual(audit[0]['name'],old.name);self.assertIn('identity',audit[0]);self.assertNotIn('items',result)
    def test_idempotent_request_after_preview_consumed(self):
        old,_=self.pair();request=self.request(self.preview(old));first=self.app.delete(request);self.assertEqual(first,self.app.delete(request))
    def test_idempotency_conflict(self):
        old,_=self.pair();request=self.request(self.preview(old));self.app.delete(request);request['confirmation']='删除 2 份备份';self.code('request_conflict',lambda:self.app.delete(request))
    def test_cross_actor_denied(self):
        old,_=self.pair();pre=self.preview(old);self.code('expired_request',lambda:self.app.delete(self.request(pre,'different')));self.assertTrue(old.exists())
    def test_expired_preview_denied(self):
        old,_=self.pair();pre=self.preview(old)
        with self.app.store.connect() as db: db.execute('UPDATE previews SET expires=0')
        self.code('expired_request',lambda:self.app.delete(self.request(pre)))
    def test_exact_confirmation_required(self):
        old,_=self.pair();req=self.request(self.preview(old));req['confirmation']='删除';self.code('invalid_request',lambda:self.app.delete(req));self.assertTrue(old.exists())
    def test_changed_file_invalidates_preview(self):
        old,_=self.pair();req=self.request(self.preview(old));old.write_bytes(b'changed');self.code('revision_conflict',lambda:self.app.delete(req));self.assertTrue(old.exists())
    def test_survivor_corruption_prevents_deletion(self):
        old,_=self.pair();req=self.request(self.preview(old));(self.base/'root'/'maibo-20261104T012700Z.tar.gz.gpg').write_bytes(b'corrupt');self.code('revision_conflict',lambda:self.app.delete(req));self.assertTrue(old.exists())
    def test_busy_backup_lock_denies_preview_and_delete(self):
        old,_=self.pair();req=self.request(self.preview(old))
        with a.locks(self.cfg['lockDirectory']):
            self.code('backup_busy',lambda:self.preview(old));self.code('backup_busy',lambda:self.app.delete(req))
    def test_no_arbitrary_path_or_oversized_selection(self):
        _,_,revision=self.app.catalog()
        for ids in (['../../key'],[{}],['a'*64]*101): self.code('invalid_request',lambda:self.app.preview({'archiveIds':ids,'catalogRevision':revision,'actor':'admin'}))
    def test_all_preflight_before_any_unlink(self):
        old,_=self.pair();second=self.file('pm-20260102.tar');os.utime(second,ns=(1,1));req=self.request(self.preview(old,second));real=a.opened
        def reject(root,relative):
            if relative==second.name: raise OSError('synthetic refusal')
            return real(root,relative)
        with patch.object(a,'opened',side_effect=reject):
            with self.assertRaises(OSError): self.app.delete(req)
        self.assertTrue(old.exists());self.assertTrue(second.exists())
    def test_partial_failure_receipt_no_auto_retry(self):
        old,_=self.pair();second=self.file('pm-20260102.tar');os.utime(second,ns=(1,1));req=self.request(self.preview(old,second));real=os.unlink
        def unlink(name,*args,**kwargs):
            if name==second.name: raise OSError('sensitive backend error')
            return real(name,*args,**kwargs)
        with patch.object(os,'unlink',side_effect=unlink): result=self.app.delete(req)
        self.assertEqual(result['status'],'partial');self.assertEqual(result['deletedCount'],1);self.assertEqual(result['error'],'operation_failed');self.assertTrue(second.exists());self.assertEqual(result,self.app.delete(req))
    def test_interrupted_receipt_never_replayed(self):
        with self.app.store.connect() as db: db.execute("INSERT INTO deletions (id,actor,request_id,payload_hash,created,status,count,bytes) VALUES ('j','a','r','h',0,'running',0,0)")
        self.app=a.Catalogue(self.cfg)
        with self.app.store.connect() as db: row=db.execute('SELECT * FROM deletions').fetchone()
        self.assertEqual(row['status'],'partial');self.assertEqual(row['error'],'operation_failed')


class ManifestTests(Fixture):
    def test_authentic_manifest_contents_only_safe_labels(self):
        contents,full,status=a.parse_tar(io.BytesIO(bundle()));self.assertTrue(full);self.assertEqual(status,'verified');self.assertNotIn('must-not-appear',json.dumps(contents));self.assertNotIn('config-files',json.dumps(contents))
    def test_hash_mismatch_rejected(self):
        with self.assertRaises(ValueError): a.parse_tar(io.BytesIO(bundle(lambda m,f:m['sha256'].update({'mb_pm.dump':'0'*64}))))
    def test_partial_database_not_full_recovery(self):
        def partial(m,f): m['databases'][0]['container']='other-database'
        self.assertFalse(a.parse_tar(io.BytesIO(bundle(partial)))[1])
    def test_wrong_database_name_not_full(self):
        def wrong(m,f):
            data=f.pop('mb_pm.dump');f['not_pm.dump']=data;m['sha256']['not_pm.dump']=m['sha256'].pop('mb_pm.dump');m['databases'][0].update(database='not_pm',file='not_pm.dump')
        self.assertFalse(a.parse_tar(io.BytesIO(bundle(wrong)))[1])
    def test_unknown_historical_manifest_not_verified(self):
        contents,full,status=a.parse_tar(io.BytesIO(bundle(lambda m,f:m.pop('sha256'))));self.assertFalse(full);self.assertEqual(status,'unknown')
    def test_traversal_symlink_duplicate_members_rejected(self):
        def add(name,kind=None):
            def extra(archive):
                item=tarfile.TarInfo(name)
                if kind: item.type=kind;item.linkname='outside'
                archive.addfile(item,io.BytesIO(b''))
            return extra
        for extra in (add('../private'),add('/absolute'),add('link',tarfile.SYMTYPE),add('mb_pm.dump')):
            with self.assertRaises(ValueError): a.parse_tar(io.BytesIO(bundle(extra=extra)))
    def test_gpg_nonzero_after_valid_tar_never_verified(self):
        path=self.file('maibo-20261104T012700Z.tar.gz.gpg');fake=Mock(stdout=io.BytesIO(bundle()));fake.wait.return_value=2;fake.poll.return_value=2
        with patch.object(a.subprocess,'Popen',return_value=fake):
            with self.assertRaises(ValueError): a.scan_archive(self.cfg,self.item(path))
    def test_gpg_success_required_and_ciphertext_hashed(self):
        path=self.file('maibo-20261104T012700Z.tar.gz.gpg');fake=Mock(stdout=io.BytesIO(bundle()));fake.wait.return_value=0;fake.poll.return_value=0
        with patch.object(a.subprocess,'Popen',return_value=fake): contents,full,status,digest=a.scan_archive(self.cfg,self.item(path))
        self.assertTrue(full);self.assertEqual(status,'verified');self.assertEqual(digest,hashlib.sha256(path.read_bytes()).hexdigest())
    def test_background_scan_failure_fixed_status_no_raw_error(self):
        path=self.file('maibo-20261104T012700Z.tar.gz.gpg')
        with patch.object(a,'scan_archive',side_effect=ValueError('PRIVATE SECRET')): self.assertTrue(self.app.scan_once())
        item=self.app.catalog()[0][self.item(path)['id']];self.assertEqual(item['status'],'unreadable');self.assertNotIn('PRIVATE',json.dumps(item,default=str))


class TimezoneTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name).resolve()
        self.zones=self.base/'zoneinfo';self.zones.mkdir()
        for name in ('Asia/Shanghai','Etc/UTC'):
            source=next((Path(root)/name for root in a.TZPATH if (Path(root)/name).is_file()),None)
            if source is None: self.skipTest('System zoneinfo files unavailable')
            target=self.zones/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read_bytes())
        self.localtime=self.base/'localtime';self.metadata=self.base/'timezone'
        self.metadata.write_text('Etc/UTC\n')
        real_path=Path
        def system_path(value):
            return {'/etc/localtime':self.localtime,'/etc/timezone':self.metadata}.get(str(value),real_path(value))
        self.paths=patch.object(a,'Path',side_effect=system_path);self.paths.start()
        self.roots=patch.object(a,'TZPATH',(str(self.zones),));self.roots.start()
        self.command=patch.object(a.subprocess,'run');self.run=self.command.start()
        self.run.side_effect=OSError('timedatectl unavailable')
        self.addCleanup(self.command.stop);self.addCleanup(self.roots.stop);self.addCleanup(self.paths.stop);self.addCleanup(self.tmp.cleanup)
    def test_localtime_symlink_wins_over_stale_utc_and_command(self):
        self.localtime.symlink_to(self.zones/'Asia/Shanghai')
        self.run.side_effect=None;self.run.return_value=Mock(stdout='Etc/UTC\n')
        self.assertEqual(a.timezone_read(),'Asia/Shanghai');self.run.assert_not_called()
    def test_relative_localtime_symlink_resolved(self):
        self.localtime.symlink_to('zoneinfo/Asia/Shanghai')
        self.assertEqual(a.timezone_read(),'Asia/Shanghai');self.run.assert_not_called()
    def test_copied_localtime_confirmed_by_timedatectl(self):
        self.localtime.write_bytes((self.zones/'Asia/Shanghai').read_bytes())
        self.run.side_effect=None;self.run.return_value=Mock(stdout='Asia/Shanghai\n')
        self.assertEqual(a.timezone_read(),'Asia/Shanghai')
        self.run.assert_called_once_with(['timedatectl','show','--property=Timezone','--value'],capture_output=True,text=True,timeout=5,check=True)
    def test_legacy_timezone_only_used_when_file_matches(self):
        self.localtime.write_bytes((self.zones/'Asia/Shanghai').read_bytes());self.metadata.write_text('Asia/Shanghai\n')
        self.assertEqual(a.timezone_read(),'Asia/Shanghai')
    def test_stale_utc_metadata_with_copied_localtime_is_unknown(self):
        self.localtime.write_bytes((self.zones/'Asia/Shanghai').read_bytes())
        self.assertEqual(a.timezone_read(),'unknown')
    def test_conflicting_timedatectl_and_metadata_never_override_localtime(self):
        self.localtime.write_bytes((self.zones/'Asia/Shanghai').read_bytes())
        self.run.side_effect=None;self.run.return_value=Mock(stdout='Etc/UTC\n')
        self.assertEqual(a.timezone_read(),'unknown')
    def test_unreadable_localtime_can_use_authoritative_service(self):
        self.run.side_effect=None;self.run.return_value=Mock(stdout='Asia/Shanghai\n')
        self.assertEqual(a.timezone_read(),'Asia/Shanghai')
    def test_unproven_metadata_without_localtime_is_unknown(self):
        self.assertEqual(a.timezone_read(),'unknown')
    def test_invalid_service_value_falls_back_only_to_matching_metadata(self):
        self.localtime.write_bytes((self.zones/'Asia/Shanghai').read_bytes());self.metadata.write_text('Asia/Shanghai\n')
        self.run.side_effect=None;self.run.return_value=Mock(stdout='not/a/timezone\n')
        self.assertEqual(a.timezone_read(),'Asia/Shanghai')
    def test_service_timeout_and_stale_metadata_fail_closed(self):
        self.localtime.write_bytes((self.zones/'Asia/Shanghai').read_bytes())
        self.run.side_effect=a.subprocess.TimeoutExpired('timedatectl',5)
        self.assertEqual(a.timezone_read(),'unknown')
    def test_plan_reports_actual_shanghai_schedule_despite_stale_utc(self):
        self.localtime.symlink_to(self.zones/'Asia/Shanghai')
        script=self.base/'daily_backup.py';script.write_text('')
        self.run.side_effect=None;self.run.return_value=Mock(stdout=f'30 3 * * * /usr/bin/python3 {script}\n',stderr='',returncode=0)
        result=a.plan_read({'planScript':script})
        self.assertEqual(result['status'],'active');self.assertEqual(result['timezone'],'Asia/Shanghai');self.assertIn('03:30',result['summary'])
        self.run.assert_called_once_with(['crontab','-l'],capture_output=True,text=True,timeout=5)


class PlanTests(Fixture):
    def plan(self,stdout,code=0,stderr=''):
        result=Mock(stdout=stdout,stderr=stderr,returncode=code)
        with patch.object(a,'timezone_read',return_value='Asia/Shanghai'),patch.object(a.subprocess,'run',return_value=result) as run:
            plan=a.plan_read(self.cfg);self.assertEqual(run.call_args.args[0],['crontab','-l']);return plan
    def test_existing_plan_and_retention(self):
        result=self.plan(f"30 3 * * * /usr/bin/python3 {self.cfg['planScript']} --key /private/sensitive-key\n")
        self.assertEqual(result['status'],'active');self.assertIn('03:30',result['summary']);self.assertIn('14',result['retentionSummary']);self.assertNotIn('sensitive',json.dumps(result))
    def test_conflicting_plan(self):
        line=f"30 3 * * * /usr/bin/python3 {self.cfg['planScript']}\n";self.assertEqual(self.plan(line+line)['status'],'conflict')
    def test_no_schedule_and_permission_failure_distinguished(self):
        self.assertEqual(self.plan('')['status'],'disabled');self.assertEqual(self.plan('',1,'no crontab for test')['status'],'disabled');self.assertEqual(self.plan('',1,'permission denied')['status'],'unknown')
    def test_other_script_not_misrepresented(self): self.assertEqual(self.plan('30 3 * * * python3 /other/daily_backup.py')['status'],'unknown')
    def test_timezone_override(self):
        result=self.plan(f'CRON_TZ=UTC\n30 3 * * * python3 {self.cfg["planScript"]}\n');self.assertEqual(result['timezone'],'UTC')
    def test_unparseable_retention_unknown(self):
        self.cfg['planScript'].write_text('keep = variable');self.assertIn('未能可靠解析',self.plan('')['retentionSummary'])


class AdditionalSafetyTests(Fixture):
    def test_different_nested_application_same_name_not_replacements(self):
        self.verified();pm=self.file('pm/data.dump');iam=self.file('iam/data.dump');self.code('protected',lambda:self.preview(pm));self.code('protected',lambda:self.preview(iam))
    def test_date_directory_same_application_old_backup_deletable(self):
        self.verified();old=self.file('pm/20260101/data.dump');new=self.file('pm/20260201/data.dump');os.utime(old,ns=(1,1));os.utime(new,ns=(2,2));self.assertEqual(self.preview(old)['itemCount'],1)
    def test_same_size_restored_mtime_invalidates_verified_cache(self):
        full=self.verified();info=full.stat();full.write_bytes(b'X'*info.st_size);os.utime(full,ns=(info.st_atime_ns,info.st_mtime_ns));self.assertIsNone(self.app.store.scan(self.item(full)))
    def test_symlink_parent_swap_blocks_without_mutation(self):
        self.verified();old=self.file('nested/pm-20260101.tar');new=self.file('nested/pm-20260201.tar');os.utime(old,ns=(1,1));os.utime(new,ns=(2,2));req=self.request(self.preview(old));(self.base/'root'/'nested').rename(self.base/'old-nested');(self.base/'root'/'nested').symlink_to(self.base/'old-nested',target_is_directory=True)
        self.code('revision_conflict',lambda:self.app.delete(req));self.assertTrue((self.base/'old-nested'/old.name).exists())

class HandlerTests(Fixture):
    def handle(self,method='GET',path='/v1/snapshot',body=b'',headers=None):
        from email.message import Message
        handler=a.Handler.__new__(a.Handler);handler.command=method;handler.path=path;handler.server=Mock(app=self.app);handler.rfile=io.BytesIO(body);handler.headers=Message();handler.reply=Mock()
        values={'Content-Length':str(len(body)),'Content-Type':'application/json',**self.signature(method,path,body)} if headers is None else headers
        for key,value in values.items():
            for item in value if isinstance(value,list) else [value]: handler.headers[key]=item
        handler.handle_request();return handler.reply.call_args.args
    def test_unconfigured_endpoints_rejected_without_side_effects(self):
        for path in ('/v1/jobs','/v1/policy','/v1/snapshot?path=/etc/passwd','/v1/deletions/../jobs'):
            self.assertEqual(self.handle(path=path)[0],400)
    def test_unsigned_request_rejected(self): self.assertEqual(self.handle(headers={})[0],401)
    def test_oversized_body_rejected(self): self.assertEqual(self.handle('POST','/v1/deletions',headers={'Content-Length':'65537'})[0],413)
    def test_chunked_body_rejected(self): self.assertEqual(self.handle(headers={'Transfer-Encoding':'chunked'})[0],400)
    def test_duplicate_content_length_rejected(self): self.assertEqual(self.handle(headers={'Content-Length':['0','0']})[0],400)
    def test_duplicate_signature_header_rejected(self):
        headers=self.signature();headers['X-Backup-Time']=[headers['X-Backup-Time']]*2;self.assertEqual(self.handle(headers=headers)[0],401)
    def test_duplicate_json_keys_rejected(self): self.assertEqual(self.handle('POST','/v1/deletions',b'{"token":"x","token":"y"}')[0],400)
    def test_invalid_utf8_rejected(self): self.assertEqual(self.handle('POST','/v1/deletions',b'\xff')[0],400)
    def test_unhandled_internal_detail_not_returned(self):
        with patch.object(self.app,'snapshot',side_effect=OSError('SECRET INTERNAL PATH')): status,value=self.handle()
        self.assertEqual(status,503);self.assertNotIn('SECRET',json.dumps(value))
    def test_valid_request_integration(self):
        old,_=self.pair();items,_,revision=self.app.catalog();data={'archiveIds':[self.item(old)['id']],'catalogRevision':revision,'actor':'admin'}
        code,preview=self.handle('POST','/v1/delete-preview',json.dumps(data).encode());self.assertEqual(code,200)
        code,result=self.handle('POST','/v1/deletions',json.dumps(self.request(preview)).encode());self.assertEqual(code,200);self.assertEqual(result['status'],'succeeded');self.assertFalse(old.exists())

if __name__=='__main__': unittest.main()
