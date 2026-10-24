import { it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ids = {
  owner: '10000000-0000-4000-8000-000000000001',
  invitee: '10000000-0000-4000-8000-000000000002',
  outsider: '10000000-0000-4000-8000-000000000003',
  admin: '10000000-0000-4000-8000-000000000004',
  other: '10000000-0000-4000-8000-000000000005',
  team: '20000000-0000-4000-8000-000000000001',
  project: '30000000-0000-4000-8000-000000000001',
  leaderDevice: '40000000-0000-4000-8000-000000000001',
  inviteeDevice: '40000000-0000-4000-8000-000000000002',
  inviteeOtherDevice: '40000000-0000-4000-8000-000000000003',
  secondInviteeDevice: '40000000-0000-4000-8000-000000000004',
};
const emails = {
  owner: 'owner@example.test', invitee: 'invitee@example.test', outsider: 'outsider@example.test', admin: 'admin@example.test', other: 'other@example.test',
};
const fingerprints = {
  leader: `SHA-256:${'1'.repeat(64)}`,
  invitee: `SHA-256:${'2'.repeat(64)}`,
  inviteeOther: `SHA-256:${'3'.repeat(64)}`,
  secondInvitee: `SHA-256:${'4'.repeat(64)}`,
};

it('enforces project invitation authority, exact email, hash rotation, expiry and invitation-bound reciprocal pins in PostgreSQL', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(
        id uuid PRIMARY KEY, aud text, role text, email text, encrypted_password text,
        email_confirmed_at timestamptz, created_at timestamptz, updated_at timestamptz,
        raw_user_meta_data jsonb DEFAULT '{}'::jsonb
      );
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    `);
    const teamsSql = readFileSync(new URL('../../../../supabase/migrations/20261022100932_mingle_teams.sql', import.meta.url), 'utf8');
    const collaborationSql = readFileSync(new URL('../../../../supabase/migrations/20261024094104_mingle_project_collaboration.sql', import.meta.url), 'utf8');
    await pg.exec(teamsSql);
    await pg.exec(collaborationSql);
    await pg.exec(readFileSync(new URL('../../../../supabase/migrations/20261024094433_mingle_invitation_limit_rls.sql', import.meta.url), 'utf8'));
    const unprotectedTables = await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity");
    assert.deepEqual(unprotectedTables.rows, [], 'Every collaboration table in the exposed schema enables RLS');

    for (const [key, id] of Object.entries(ids).filter(([key]) => ['owner', 'invitee', 'outsider', 'admin', 'other'].includes(key))) {
      const email = emails[key as keyof typeof emails];
      await pg.query('INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_user_meta_data) VALUES ($1,$2,$2,$3,$4,now(),now(),now(),$5)',
        [id, 'authenticated', email, '', JSON.stringify({ full_name: key })]);
    }

    async function asUser<T>(accountId: string, email: string, work: () => Promise<T>): Promise<T> {
      await pg.query('SELECT set_config($1,$2,false),set_config($3,$4,false)', [
        'request.jwt.claim.sub', accountId, 'request.jwt.claims', JSON.stringify({ sub: accountId, email, role: 'authenticated' }),
      ]);
      await pg.exec('SET ROLE authenticated');
      try { return await work(); } finally { await pg.exec('RESET ROLE'); }
    }

    const leaderId = ids.leaderDevice;
    await asUser(ids.owner, emails.owner, async () => {
      await pg.query('INSERT INTO mingle_teams(id,name,owner_id) VALUES ($1,$2,$3)', [ids.team, 'Collaboration fixture', ids.owner]);
      await pg.query('INSERT INTO mingle_projects(id,team_id,name,repository_url) VALUES ($1,$2,$3,$4)',
        [ids.project, ids.team, 'Example repo', 'https://github.com/example/project.git']);
      await pg.query(`INSERT INTO mingle_devices(id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [leaderId, ids.team, ids.owner, 'Leader desktop', 's'.repeat(80), 'e'.repeat(80), fingerprints.leader]);
      const scoped = await pg.query<{ scope_mingle_team_to_project: boolean }>(
        'SELECT scope_mingle_team_to_project($1)', [ids.project]);
      assert.equal(scoped.rows[0]!.scope_mingle_team_to_project, true, 'project bootstrap creates a durable one-project team scope');
      await pg.query(`INSERT INTO mingle_invitations(team_id,email,role,token_hash,expires_at)
        VALUES ($1,$2,'admin',$3,now()+interval '1 day')`, [ids.team, emails.admin, '9'.repeat(64)]);
    });

    await asUser(ids.admin, emails.admin, async () => {
      await pg.query('SELECT accept_mingle_invitation($1)', ['9'.repeat(64)]);
      await assert.rejects(pg.query(`INSERT INTO mingle_projects(id,team_id,name,repository_url)
        VALUES ($1,$2,$3,$4)`, ['30000000-0000-4000-8000-000000000002', ids.team, 'Extra project', 'https://github.com/example/extra.git']));
      const visible = await pg.query('SELECT id FROM mingle_projects WHERE team_id=$1', [ids.team]);
      assert.equal(visible.rows.length, 1, 'even an active team admin can see only the project-first team’s scoped project');
      await assert.rejects(pg.query('SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.outsider, 'member', leaderId, fingerprints.leader, '8'.repeat(64)]));
    });

    await asUser(ids.owner, emails.owner, async () => {
      await pg.query('INSERT INTO mingle_teams(id,name,owner_id) VALUES ($1,$2,$3)', ['20000000-0000-4000-8000-000000000002', 'Manual team', ids.owner]);
      await pg.query(`INSERT INTO mingle_projects(id,team_id,name,repository_url) VALUES
        ('30000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000002','Manual one','https://github.com/example/one.git'),
        ('30000000-0000-4000-8000-000000000012','20000000-0000-4000-8000-000000000002','Manual two','https://github.com/example/two.git')`);
      const manual = await pg.query('SELECT id FROM mingle_projects WHERE team_id=$1', ['20000000-0000-4000-8000-000000000002']);
      assert.equal(manual.rows.length, 2, 'unscoped manually managed teams retain their existing multi-project behavior');
    });

    const initialTokenHash = 'a'.repeat(64);
    const rotatedTokenHash = 'b'.repeat(64);
    let invitationId = '';
    let reenrollmentInvitationId = '';
    await asUser(ids.owner, emails.owner, async () => {
      const created = await pg.query<{ create_mingle_project_invitation: { id: string } }>(
        'SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.invitee, 'member', leaderId, fingerprints.leader, initialTokenHash]);
      invitationId = created.rows[0]!.create_mingle_project_invitation.id;
      assert.ok(invitationId);
      await pg.query('SELECT rotate_mingle_project_invitation($1,$2)', [invitationId, rotatedTokenHash]);
      const row = await pg.query<{ token_hash: string }>('SELECT token_hash FROM mingle_project_invitations WHERE id=$1', [invitationId]);
      assert.equal(row.rows[0]!.token_hash, rotatedTokenHash, 'the authenticated rotate RPC changes only the one-time token hash');
      const claimed = await pg.query<{ claim_mingle_project_invitation_delivery: { claimed: boolean } }>(
        'SELECT claim_mingle_project_invitation_delivery($1,$2)', [invitationId, rotatedTokenHash]);
      assert.equal(claimed.rows[0]!.claim_mingle_project_invitation_delivery.claimed, true, 'the first server delivery obtains a rate-limit claim');
      const throttled = await pg.query<{ claim_mingle_project_invitation_delivery: { claimed: boolean; reason: string } }>(
        'SELECT claim_mingle_project_invitation_delivery($1,$2)', [invitationId, rotatedTokenHash]);
      assert.equal(throttled.rows[0]!.claim_mingle_project_invitation_delivery.claimed, false, 'a second send to the same recipient is throttled');
      assert.equal(throttled.rows[0]!.claim_mingle_project_invitation_delivery.reason, 'cooldown');
      await assert.rejects(pg.query('UPDATE mingle_project_invitations SET accepted_at=now(),accepted_by=$1 WHERE id=$2', [ids.invitee, invitationId]));
    });
    await pg.query('UPDATE mingle_project_invitation_owner_limits SET hourly_attempt_count=10 WHERE team_id=$1 AND invited_by=$2', [ids.team, ids.owner]);
    await asUser(ids.owner, emails.owner, async () => {
      const created = await pg.query<{ create_mingle_project_invitation: { id: string } }>(
        'SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.other, 'member', leaderId, fingerprints.leader, '7'.repeat(64)]);
      const capped = await pg.query<{ claim_mingle_project_invitation_delivery: { claimed: boolean; reason: string } }>(
        'SELECT claim_mingle_project_invitation_delivery($1,$2)', [created.rows[0]!.create_mingle_project_invitation.id, '7'.repeat(64)]);
      assert.equal(capped.rows[0]!.claim_mingle_project_invitation_delivery.claimed, false);
      assert.equal(capped.rows[0]!.claim_mingle_project_invitation_delivery.reason, 'owner_hourly_limit', 'separate recipients share an account/team hourly cap');
    });
    await pg.query('UPDATE mingle_project_invitation_owner_limits SET hourly_attempt_count=1 WHERE team_id=$1 AND invited_by=$2', [ids.team, ids.owner]);

    await asUser(ids.outsider, emails.outsider, async () => {
      await assert.rejects(pg.query('SELECT preview_mingle_project_invitation($1)', [rotatedTokenHash]));
      await assert.rejects(pg.query('SELECT accept_mingle_project_invitation($1)', [rotatedTokenHash]));
    });
    await asUser(ids.invitee, emails.invitee, async () => {
      await assert.rejects(pg.query('SELECT preview_mingle_project_invitation($1)', [initialTokenHash]), 'rotated bearer token is invalid');
      const preview = await pg.query<{ preview_mingle_project_invitation: { email: string; project_name: string } }>(
        'SELECT preview_mingle_project_invitation($1)', [rotatedTokenHash]);
      assert.equal(preview.rows[0]!.preview_mingle_project_invitation.email, emails.invitee);
      assert.equal(preview.rows[0]!.preview_mingle_project_invitation.project_name, 'Example repo');
      const accepted = await pg.query<{ accept_mingle_project_invitation: { team_id: string; already_accepted: boolean } }>(
        'SELECT accept_mingle_project_invitation($1)', [rotatedTokenHash]);
      assert.equal(accepted.rows[0]!.accept_mingle_project_invitation.team_id, ids.team);
      assert.equal(accepted.rows[0]!.accept_mingle_project_invitation.already_accepted, false);
      const acceptedAgain = await pg.query<{ accept_mingle_project_invitation: { team_id: string; already_accepted: boolean } }>(
        'SELECT accept_mingle_project_invitation($1)', [rotatedTokenHash]);
      assert.equal(acceptedAgain.rows[0]!.accept_mingle_project_invitation.already_accepted, true,
        'one invitation acceptance can safely anchor every selected local agent on a retry');
      const membership = await pg.query<{ role: string }>('SELECT role FROM mingle_members WHERE team_id=$1 AND user_id=$2 AND revoked_at IS NULL', [ids.team, ids.invitee]);
      assert.equal(membership.rows[0]!.role, 'member');
      const profile = await pg.query<{ email: string }>('SELECT email FROM mingle_project_member_profiles WHERE team_id=$1 AND user_id=$2', [ids.team, ids.invitee]);
      assert.equal(profile.rows[0]!.email, emails.invitee);
      const sharedProject = await pg.query('SELECT id FROM mingle_projects WHERE id=$1', [ids.project]);
      assert.equal(sharedProject.rows.length, 1, 'membership retains the existing team-wide shared-project visibility policy');
    });

    await asUser(ids.invitee, emails.invitee, async () => {
      await pg.query(`INSERT INTO mingle_devices(id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ids.inviteeDevice, ids.team, ids.invitee, 'Invitee desktop', 't'.repeat(80), 'f'.repeat(80), fingerprints.invitee]);
      await pg.query(`INSERT INTO mingle_devices(id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ids.inviteeOtherDevice, ids.team, ids.invitee, 'Other invitee desktop', 'u'.repeat(80), 'g'.repeat(80), fingerprints.inviteeOther]);
      await assert.rejects(pg.query('SELECT complete_mingle_project_invitation_enrollment($1,$2,$3)', [invitationId, ids.inviteeDevice, fingerprints.leader]));
      const linked = await pg.query<{ complete_mingle_project_invitation_enrollment: boolean }>(
        'SELECT complete_mingle_project_invitation_enrollment($1,$2,$3)', [invitationId, ids.inviteeDevice, fingerprints.invitee]);
      assert.equal(linked.rows[0]!.complete_mingle_project_invitation_enrollment, true);
      const links = await pg.query<{ count: number }>(`SELECT count(*)::integer AS count FROM mingle_device_links WHERE team_id=$1
        AND ((device_id=$2 AND peer_device_id=$3 AND peer_fingerprint=$4)
          OR (device_id=$3 AND peer_device_id=$2 AND peer_fingerprint=$5))`,
      [ids.team, leaderId, ids.inviteeDevice, fingerprints.invitee, fingerprints.leader]);
      assert.equal(links.rows[0]!.count, 2, 'the grant creates reciprocal pins only for the invitation’s leader and exact invitee device');
      const retry = await pg.query<{ complete_mingle_project_invitation_enrollment: boolean }>(
        'SELECT complete_mingle_project_invitation_enrollment($1,$2,$3)', [invitationId, ids.inviteeDevice, fingerprints.invitee]);
      assert.equal(retry.rows[0]!.complete_mingle_project_invitation_enrollment, true, 'same exact device enrollment is idempotent');
      await assert.rejects(pg.query('SELECT complete_mingle_project_invitation_enrollment($1,$2,$3)', [invitationId, ids.inviteeOtherDevice, fingerprints.inviteeOther]));
    });

    await asUser(ids.owner, emails.owner, async () => {
      await assert.rejects(pg.query('SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.invitee, 'member', leaderId, fingerprints.leader, '8'.repeat(64)]),
      'a fully enrolled active member does not receive duplicate project invitations');
      await pg.query('DELETE FROM mingle_device_links WHERE team_id=$1 AND device_id=$2 AND peer_device_id=$3',
        [ids.team, leaderId, ids.inviteeDevice]);
      const created = await pg.query<{ create_mingle_project_invitation: { id: string } }>(
        'SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.invitee, 'admin', leaderId, fingerprints.leader, '8'.repeat(64)]);
      reenrollmentInvitationId = created.rows[0]!.create_mingle_project_invitation.id;
      assert.ok(reenrollmentInvitationId, 'leader can issue a fresh invite to recover incomplete device enrollment');
    });
    await asUser(ids.invitee, emails.invitee, async () => {
      await pg.query('SELECT accept_mingle_project_invitation($1)', ['8'.repeat(64)]);
      const memberships = await pg.query<{ count: number; role: string }>(`SELECT count(*)::integer AS count,min(role) AS role
        FROM mingle_members WHERE team_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [ids.team, ids.invitee]);
      assert.equal(memberships.rows[0]!.count, 1, 're-enrollment does not create a duplicate membership or elevate the existing role');
      assert.equal(memberships.rows[0]!.role, 'member');
      const completion = await pg.query<{ complete_mingle_project_invitation_enrollment: boolean }>(
        'SELECT complete_mingle_project_invitation_enrollment($1,$2,$3)',
        [reenrollmentInvitationId, ids.inviteeDevice, fingerprints.invitee]);
      assert.equal(completion.rows[0]!.complete_mingle_project_invitation_enrollment, true);
    });

    await asUser(ids.invitee, emails.invitee, async () => {
      await assert.rejects(pg.query('SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.outsider, 'member', leaderId, fingerprints.leader, 'c'.repeat(64)]));
    });
    await asUser(ids.owner, emails.owner, async () => {
      const pending = await pg.query<{ create_mingle_project_invitation: { id: string } }>(
        'SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.outsider, 'member', leaderId, fingerprints.leader, 'd'.repeat(64)]);
      const pendingId = pending.rows[0]!.create_mingle_project_invitation.id;
      const revoked = await pg.query<{ revoke_mingle_project_invitation: boolean }>('SELECT revoke_mingle_project_invitation($1)', [pendingId]);
      assert.equal(revoked.rows[0]!.revoke_mingle_project_invitation, true);
      const state = await pg.query<{ revoked_at: string | null }>('SELECT revoked_at FROM mingle_project_invitations WHERE id=$1', [pendingId]);
      assert.ok(state.rows[0]!.revoked_at, 'revocation is persisted by the owner-only RPC');
    });
    await asUser(ids.outsider, emails.outsider, async () => {
      await assert.rejects(pg.query('SELECT preview_mingle_project_invitation($1)', ['d'.repeat(64)]));
    });

    let expiredInvitationId = '';
    await asUser(ids.owner, emails.owner, async () => {
      const created = await pg.query<{ id: string }>(`INSERT INTO mingle_project_invitations(
        team_id,shared_project_id,email,role,invited_by,leader_device_id,leader_fingerprint,token_hash,expires_at
      ) VALUES ($1,$2,$3,'member',$4,$5,$6,$7,now()+interval '40 milliseconds') RETURNING id`,
      [ids.team, ids.project, emails.outsider, ids.owner, leaderId, fingerprints.leader, 'e'.repeat(64)]);
      expiredInvitationId = created.rows[0]!.id;
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    await asUser(ids.outsider, emails.outsider, async () => {
      await assert.rejects(pg.query('SELECT preview_mingle_project_invitation($1)', ['e'.repeat(64)]));
      await assert.rejects(pg.query('SELECT accept_mingle_project_invitation($1)', ['e'.repeat(64)]));
    });

    let enrollmentInvitationId = '';
    await asUser(ids.owner, emails.owner, async () => {
      const created = await pg.query<{ create_mingle_project_invitation: { id: string } }>(
        'SELECT create_mingle_project_invitation($1,$2,$3,$4,$5,$6)',
        [ids.project, emails.other, 'member', leaderId, fingerprints.leader, 'f'.repeat(64)]);
      enrollmentInvitationId = created.rows[0]!.create_mingle_project_invitation.id;
    });
    await asUser(ids.other, emails.other, async () => {
      await pg.query('SELECT accept_mingle_project_invitation($1)', ['f'.repeat(64)]);
      await pg.query(`INSERT INTO mingle_devices(id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ids.secondInviteeDevice, ids.team, ids.other, 'Second invitee desktop', 'v'.repeat(80), 'h'.repeat(80), fingerprints.secondInvitee]);
    });
    await pg.query(`UPDATE mingle_project_invitation_enrollments SET expires_at=now()-interval '1 second' WHERE invitation_id=$1`, [enrollmentInvitationId]);
    await asUser(ids.other, emails.other, async () => {
      await assert.rejects(pg.query('SELECT complete_mingle_project_invitation_enrollment($1,$2,$3)',
        [enrollmentInvitationId, ids.secondInviteeDevice, fingerprints.secondInvitee]));
    });
    assert.ok(expiredInvitationId);
  } finally {
    await pg.close();
  }
}, 30_000);
