/**
 * Security Rules Verification Spec for M-Channel PMS Sync Service
 * Covers the Dirty Dozen payloads documented in security_spec.md.
 */

export const dirtyDozenCases = [
  { name: 'Unauthenticated Property Read', operation: 'get', path: '/properties/prop-1', auth: null, expected: 'PERMISSION_DENIED' },
  { name: 'Cross-Tenant Property Read', operation: 'get', path: '/properties/prop-1', auth: { uid: 'userB', email_verified: true }, expected: 'PERMISSION_DENIED' },
  { name: 'Secret Exfiltration', operation: 'get', path: '/properties/prop-1/secrets/credentials', auth: { uid: 'userA', email_verified: true }, expected: 'PERMISSION_DENIED' },
  { name: 'Secret Write Injection', operation: 'create', path: '/properties/prop-1/secrets/credentials', auth: { uid: 'userA', email_verified: true }, expected: 'PERMISSION_DENIED' },
  { name: 'Unverified Email Write', operation: 'create', path: '/users/userA', auth: { uid: 'userA', email_verified: false }, expected: 'PERMISSION_DENIED' },
  { name: 'Identity Spoofing on Property Create', operation: 'create', path: '/properties/prop-2', auth: { uid: 'userB', email_verified: true }, payload: { ownerUid: 'userA' }, expected: 'PERMISSION_DENIED' },
  { name: 'Shadow Field Injection', operation: 'create', path: '/properties/prop-2', auth: { uid: 'userB', email_verified: true }, payload: { isAdmin: true }, expected: 'PERMISSION_DENIED' },
  { name: 'ID Poisoning', operation: 'get', path: `/properties/${'a'.repeat(300)}`, auth: { uid: 'userA', email_verified: true }, expected: 'PERMISSION_DENIED' },
  { name: 'Blanket List Query', operation: 'list', path: '/properties', auth: { uid: 'userB', email_verified: true }, expected: 'PERMISSION_DENIED' },
  { name: 'Owner Reassignment on Update', operation: 'update', path: '/properties/prop-1', auth: { uid: 'userA', email_verified: true }, payload: { ownerUid: 'userB' }, expected: 'PERMISSION_DENIED' },
  { name: 'Value Poisoning on Status', operation: 'update', path: '/properties/prop-1', auth: { uid: 'userA', email_verified: true }, payload: { status: 'hacked_status' }, expected: 'PERMISSION_DENIED' },
  { name: 'Client Subcollection Spoofing', operation: 'create', path: '/properties/prop-1/outbox/batch-1', auth: { uid: 'userB', email_verified: true }, expected: 'PERMISSION_DENIED' },
] as const;
