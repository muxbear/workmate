import uuid
import bcrypt
import psycopg

conn = psycopg.connect('host=10.8.0.32 port=5432 dbname=ke_hermes user=admin password=P5Ez52Vzes3G')
cur = conn.cursor()
account_id = '11111111-1111-4111-8111-111111111111'
role_id = '70c7e7b4-4042-4533-93f8-c7087b0a7f7d'
password_hash = bcrypt.hashpw(b'Test2026', bcrypt.gensalt()).decode()
cur.execute('insert into accounts (id, username, nickname, password_hash, avatar, workspace_id, is_active) values (%s, %s, %s, %s, %s, %s, %s) on conflict (id) do nothing', (account_id, 'param_test_admin', '参数测试管理员', password_hash, '', 'default', True))
cur.execute('delete from user_roles where user_id = %s', (account_id,))
cur.execute('insert into user_roles (user_id, role_id, assigned_at, assigned_by) values (%s, %s, now(), %s)', (account_id, role_id, account_id))
conn.commit()
print('account ready')
conn.close()
