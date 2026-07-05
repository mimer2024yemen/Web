export const rolePermissions: Record<string, string[]> = {
  'super-admin': ['*'],
  admin: [
    'dashboard.read',
    'sites.read', 'sites.write', 'sites.test', 'sites.sync',
    'articles.read', 'articles.write', 'articles.publish',
    'media.read', 'media.write',
    'queue.read', 'queue.process',
    'users.read', 'users.write',
    'settings.read', 'settings.write',
    'logs.read',
    'webhooks.read', 'webhooks.write',
    'security.read', 'security.write',
  ],
  publisher: [
    'dashboard.read',
    'sites.read', 'sites.test',
    'articles.read', 'articles.write', 'articles.publish',
    'media.read', 'media.write',
    'queue.read', 'queue.process',
    'logs.read',
  ],
  editor: [
    'dashboard.read',
    'sites.read',
    'articles.read', 'articles.write',
    'media.read', 'media.write',
    'queue.read',
  ],
  viewer: [
    'dashboard.read',
    'sites.read',
    'articles.read',
    'media.read',
    'queue.read',
    'logs.read',
  ],
};

export function normalizeRole(role?: string | null) {
  if (!role) return 'viewer';
  return rolePermissions[role] ? role : 'viewer';
}

export function resolvePermissions(role?: string | null, customPermissions?: string[] | null) {
  const base = [...(rolePermissions[normalizeRole(role)] ?? [])];
  const merged = new Set(base);
  for (const permission of customPermissions ?? []) {
    if (permission?.trim()) merged.add(permission.trim());
  }
  return [...merged];
}

export function hasPermission(permissions: string[], required: string) {
  return permissions.includes('*') || permissions.includes(required);
}

export function availablePermissions() {
  return [
    'dashboard.read',
    'sites.read', 'sites.write', 'sites.test', 'sites.sync',
    'articles.read', 'articles.write', 'articles.publish',
    'media.read', 'media.write',
    'queue.read', 'queue.process',
    'users.read', 'users.write',
    'settings.read', 'settings.write',
    'logs.read',
    'webhooks.read', 'webhooks.write',
    'security.read', 'security.write',
  ];
}
