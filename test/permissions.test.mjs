import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  can,
  canHaveRole,
  canDecideProposal,
  isBootstrap,
  route,
  LIMITS,
} from '../src/permissions.js';

const ROLES = ['viewer', 'contributor', 'admin', 'owner'];

// Peran minimum per aksi (PRD Bagian 3)
const MIN = {
  'tree.read': 'viewer',
  'photo.report': 'viewer',
  'person.propose': 'contributor',
  'photo.upload': 'contributor',
  'person.edit_direct': 'admin',
  'proposal.decide': 'admin',
  'member.invite': 'admin',
  'member.remove': 'admin',
  'audit.read': 'admin',
  'export.run': 'admin',
  'photo.moderate': 'admin',
  'member.set_admin': 'owner',
  'backup.restore': 'owner',
};

test('matriks izin: setiap aksi hanya untuk peran minimum ke atas', () => {
  for (const [action, min] of Object.entries(MIN)) {
    for (const role of ROLES) {
      const expected = ROLES.indexOf(role) >= ROLES.indexOf(min);
      assert.equal(can(role, action), expected, `${role} -> ${action}`);
    }
  }
});

test('peran atau aksi tak dikenal selalu ditolak', () => {
  assert.equal(can('hacker', 'tree.read'), false);
  assert.equal(can(undefined, 'tree.read'), false);
  assert.equal(can('owner', 'aksi.tidak.ada'), false);
  assert.equal(can('owner', undefined), false);
});

test('Viewer tidak bisa mengunggah foto, tapi bisa melapor (U9)', () => {
  assert.equal(can('viewer', 'photo.upload'), false);
  assert.equal(can('viewer', 'photo.report'), true);
});

test('Contributor tidak bisa ekspor dan tidak bisa melihat audit log', () => {
  assert.equal(can('contributor', 'export.run'), false);
  assert.equal(can('contributor', 'audit.read'), false);
});

test('restore backup dan penunjukan Admin hanya Owner', () => {
  assert.equal(can('admin', 'backup.restore'), false);
  assert.equal(can('admin', 'member.set_admin'), false);
  assert.equal(can('owner', 'backup.restore'), true);
  assert.equal(can('owner', 'member.set_admin'), true);
});

test('batas peran: maks 2 Owner dan 3 Admin', () => {
  assert.deepEqual(LIMITS, { owner: 2, admin: 3 });
  assert.equal(canHaveRole({ owner: 1, admin: 0 }, 'owner'), true);
  assert.equal(canHaveRole({ owner: 2, admin: 0 }, 'owner'), false);
  assert.equal(canHaveRole({ owner: 1, admin: 2 }, 'admin'), true);
  assert.equal(canHaveRole({ owner: 1, admin: 3 }, 'admin'), false);
  assert.equal(canHaveRole({}, 'owner'), true);
  assert.equal(canHaveRole({ owner: 2, admin: 3 }, 'contributor'), true);
  assert.equal(canHaveRole({ owner: 2, admin: 3 }, 'viewer'), true);
});

test('Mode Penyusunan Awal: hanya satu Owner dan nol Admin', () => {
  assert.equal(isBootstrap({ owners: 1, admins: 0 }), true);
  assert.equal(isBootstrap({ owners: 1, admins: 1 }), false);
  assert.equal(isBootstrap({ owners: 2, admins: 0 }), false);
  assert.equal(isBootstrap({ owners: 0, admins: 0 }), false);
});

test('route: Viewer tidak boleh mengubah apa pun', () => {
  for (const kind of ['person_edit', 'parent_child', 'merge', 'tidak_dikenal']) {
    assert.equal(route({ role: 'viewer', kind, bootstrap: false }), 'forbidden');
  }
});

test('route: Contributor selalu lewat proposal, bahkan saat bootstrap', () => {
  for (const kind of ['person_edit', 'person_create', 'partnership', 'archive', 'parent_child', 'merge']) {
    assert.equal(route({ role: 'contributor', kind, bootstrap: false }), 'proposal', kind);
    assert.equal(route({ role: 'contributor', kind, bootstrap: true }), 'proposal', kind);
  }
});

test('route: Admin/Owner langsung untuk nama, profil baru, pasangan, arsip', () => {
  for (const role of ['admin', 'owner']) {
    for (const kind of ['person_edit', 'person_create', 'partnership', 'archive']) {
      assert.equal(route({ role, kind, bootstrap: false }), 'direct', `${role} ${kind}`);
    }
  }
});

test('route: relasi orang tua-anak butuh persetujuan kedua di luar bootstrap', () => {
  for (const role of ['admin', 'owner']) {
    assert.equal(route({ role, kind: 'parent_child', bootstrap: false }), 'proposal');
    assert.equal(route({ role, kind: 'parent_child', bootstrap: true }), 'direct');
  }
});

test('route: merge dan unmerge diblokir saat bootstrap, proposal di luarnya', () => {
  for (const kind of ['merge', 'unmerge']) {
    assert.equal(route({ role: 'owner', kind, bootstrap: true }), 'blocked_bootstrap');
    assert.equal(route({ role: 'owner', kind, bootstrap: false }), 'proposal');
  }
});

test('route: jenis tak dikenal jatuh ke proposal (gagal aman), bukan direct', () => {
  assert.equal(route({ role: 'owner', kind: 'jenis_baru', bootstrap: false }), 'proposal');
  assert.equal(route({ role: 'owner', kind: 'jenis_baru', bootstrap: true }), 'proposal');
});

// Keputusan terbuka: PRD P1-1 menyebut "arsip" langsung di bootstrap, tapi tidak tegas soal
// PEMULIHAN arsip. Tes ini mengunci perilaku kode saat ini supaya perubahannya disengaja.
test('route: archive_restore saat bootstrap saat ini langsung (belum dikonfirmasi PRD)', () => {
  assert.equal(route({ role: 'owner', kind: 'archive_restore', bootstrap: true }), 'direct');
  assert.equal(route({ role: 'owner', kind: 'archive_restore', bootstrap: false }), 'proposal');
});

test('pengaju tidak boleh menyetujui proposalnya sendiri', () => {
  assert.equal(canDecideProposal({ role: 'admin', deciderId: 'u1', proposerId: 'u1' }), false);
  assert.equal(canDecideProposal({ role: 'owner', deciderId: 'u1', proposerId: 'u1' }), false);
  assert.equal(canDecideProposal({ role: 'admin', deciderId: 'u2', proposerId: 'u1' }), true);
});

test('Contributor tidak boleh memutuskan proposal siapa pun', () => {
  assert.equal(canDecideProposal({ role: 'contributor', deciderId: 'u2', proposerId: 'u1' }), false);
  assert.equal(canDecideProposal({ role: 'viewer', deciderId: 'u2', proposerId: 'u1' }), false);
});
