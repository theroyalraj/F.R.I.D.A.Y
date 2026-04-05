/**
 * Contacts management with tags for filtering and organization.
 * Supports phone, email, and custom metadata.
 */

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  tags: string[];
  notes?: string;
  avatar?: string; // emoji or initials
  addedAt?: string; // ISO 8601
  lastContacted?: string; // ISO 8601
}

export interface ContactsConfig {
  contacts: Contact[];
  tags: string[]; // available tag options
}

/** Default contacts with common tags for organization */
export const DEFAULT_CONTACTS: Contact[] = [
  {
    id: 'contact-1',
    name: 'Sarah Chen',
    email: 'sarah.chen@company.com',
    phone: '+1-555-0101',
    company: 'Main Corp',
    role: 'Product Manager',
    tags: ['team', 'product', 'internal'],
    avatar: '👩‍💼',
  },
  {
    id: 'contact-2',
    name: 'Marcus Johnson',
    email: 'marcus@company.com',
    phone: '+1-555-0102',
    company: 'Main Corp',
    role: 'Engineering Lead',
    tags: ['team', 'engineering', 'internal'],
    avatar: '👨‍💻',
  },
  {
    id: 'contact-3',
    name: 'Alex Rodriguez',
    email: 'alex.rodriguez@external.io',
    phone: '+1-555-0103',
    company: 'Partner Inc',
    role: 'VP Sales',
    tags: ['partner', 'sales', 'external'],
    avatar: '👔',
  },
  {
    id: 'contact-4',
    name: 'Priya Patel',
    email: 'priya@consulting.com',
    phone: '+1-555-0104',
    company: 'Consulting Group',
    role: 'Consultant',
    tags: ['consultant', 'external', 'strategy'],
    avatar: '📊',
  },
];

/** Available tag categories for filtering */
export const CONTACT_TAG_CATEGORIES: Record<string, string[]> = {
  organization: ['team', 'partner', 'consultant', 'vendor'],
  function: ['sales', 'engineering', 'product', 'operations', 'strategy'],
  scope: ['internal', 'external', 'global'],
  type: ['individual', 'group', 'company'],
};

/** All available tags flattened */
export function getAllContactTags(): string[] {
  const tags = new Set<string>();
  for (const categoryTags of Object.values(CONTACT_TAG_CATEGORIES)) {
    categoryTags.forEach(tag => tags.add(tag));
  }
  return Array.from(tags).sort();
}

/** Filter contacts by tags (AND logic: contact must have ALL specified tags) */
export function filterContactsByTags(
  contacts: Contact[],
  selectedTags: string[],
): Contact[] {
  if (selectedTags.length === 0) return contacts;
  return contacts.filter(contact =>
    selectedTags.every(tag => contact.tags.includes(tag)),
  );
}

/** Search contacts by name, email, phone, company, or role */
export function searchContacts(
  contacts: Contact[],
  query: string,
): Contact[] {
  if (!query.trim()) return contacts;
  const q = query.toLowerCase();
  return contacts.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.email?.toLowerCase().includes(q) ||
    c.phone?.includes(q) ||
    c.company?.toLowerCase().includes(q) ||
    c.role?.toLowerCase().includes(q),
  );
}

/** Get contacts matching both search and tag filters */
export function filterContacts(
  contacts: Contact[],
  query: string,
  tags: string[],
): Contact[] {
  let result = contacts;
  if (query.trim()) {
    result = searchContacts(result, query);
  }
  if (tags.length > 0) {
    result = filterContactsByTags(result, tags);
  }
  return result;
}

/** Get most recently contacted */
export function getMostRecentContacts(
  contacts: Contact[],
  limit: number = 5,
): Contact[] {
  return [...contacts]
    .filter(c => c.lastContacted)
    .sort((a, b) => {
      const aTime = new Date(a.lastContacted || 0).getTime();
      const bTime = new Date(b.lastContacted || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}

/** Get contact by name (case-insensitive) */
export function findContactByName(
  contacts: Contact[],
  name: string,
): Contact | undefined {
  const q = name.toLowerCase();
  return contacts.find(c => c.name.toLowerCase() === q);
}

/** Get contact by phone number */
export function findContactByPhone(
  contacts: Contact[],
  phone: string,
): Contact | undefined {
  const normalized = phone.replace(/\D/g, '');
  return contacts.find(c => (c.phone || '').replace(/\D/g, '') === normalized);
}

const LS_CONTACTS = 'openclaw.contacts';

/** Load contacts from localStorage */
export function loadContacts(): Contact[] {
  try {
    const s = localStorage.getItem(LS_CONTACTS);
    if (!s) return [...DEFAULT_CONTACTS];
    const contacts = JSON.parse(s) as Contact[];
    return Array.isArray(contacts) ? contacts : DEFAULT_CONTACTS;
  } catch {
    return DEFAULT_CONTACTS;
  }
}

/** Save contacts to localStorage */
export function saveContacts(contacts: Contact[]): void {
  try {
    localStorage.setItem(LS_CONTACTS, JSON.stringify(contacts));
  } catch {
    /* ignore */
  }
}

/** Add new contact */
export function addContact(contact: Omit<Contact, 'id' | 'addedAt'>): Contact {
  const newContact: Contact = {
    ...contact,
    id: `contact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    addedAt: new Date().toISOString(),
  };
  return newContact;
}

/** Update contact */
export function updateContact(id: string, updates: Partial<Contact>): Contact | null {
  const contacts = loadContacts();
  const index = contacts.findIndex(c => c.id === id);
  if (index === -1) return null;
  const updated = { ...contacts[index], ...updates, id }; // preserve id
  contacts[index] = updated;
  saveContacts(contacts);
  return updated;
}

/** Delete contact */
export function deleteContact(id: string): boolean {
  const contacts = loadContacts();
  const filtered = contacts.filter(c => c.id !== id);
  if (filtered.length === contacts.length) return false;
  saveContacts(filtered);
  return true;
}

/** Mark contact as recently contacted */
export function updateLastContacted(id: string): Contact | null {
  return updateContact(id, { lastContacted: new Date().toISOString() });
}
