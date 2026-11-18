const RANK = { viewer: 1, contributor: 2, admin: 3, owner: 4 };

export const LIMITS = { owner: 2, admin: 3 };

const MIN_ROLE = {
  'tree.read': 'viewer',
  'person.propose': 'contributor',
  'person.edit_direct': 'admin',
  'proposal.decide': 'admin',
  'member.invite': 'admin',
  'member.remove': 'admin',
  'member.set_admin': 'owner',
  'audit.read': 'admin',
  'export.run': 'admin',
  'backup.restore': 'owner',
  'photo.upload': 'contributor',
  'photo.report': 'viewer',
  'photo.moderate': 'admin',
};

export function can(role, action) {
  const min = MIN_ROLE[action];
  return Boolean(min && RANK[role] && RANK[role] >= RANK[min]);
}

export function isBootstrap({ owners, admins }) {
  return owners === 1 && admins === 0;
}

export function canHaveRole(counts, role) {
  const limit = LIMITS[role];
  return limit === undefined || (counts[role] ?? 0) < limit;
}

const DIRECT_FOR_MANAGER = ['person_edit', 'person_create', 'partnership', 'archive'];
const NEEDS_SECOND_APPROVER = ['parent_child', 'archive_restore'];
const NEVER_IN_BOOTSTRAP = ['merge', 'unmerge'];

export function route({ role, kind, bootstrap }) {
  if (!can(role, 'person.propose')) return 'forbidden';
  if (!can(role, 'person.edit_direct')) return 'proposal';
  if (NEVER_IN_BOOTSTRAP.includes(kind)) return bootstrap ? 'blocked_bootstrap' : 'proposal';
  if (DIRECT_FOR_MANAGER.includes(kind)) return 'direct';
  if (NEEDS_SECOND_APPROVER.includes(kind)) return bootstrap ? 'direct' : 'proposal';
  return 'proposal';
}

export function canDecideProposal({ role, deciderId, proposerId }) {
  return can(role, 'proposal.decide') && deciderId !== proposerId;
}
