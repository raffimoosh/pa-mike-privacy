import type {
  Account,
  CardTransaction,
  DomainEvent,
  Hold,
  Payment,
  Transfer,
  User,
} from "./types.js";

/**
 * Minimal async table interface. The engine only needs get/put/find/list, which keeps
 * a Prisma (Postgres) implementation mechanical: one class per table.
 */
export interface Table<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(row: T): Promise<T>;
  find(pred: (row: T) => boolean): Promise<T | undefined>;
  list(pred?: (row: T) => boolean): Promise<T[]>;
}

export interface Store {
  users: Table<User>;
  accounts: Table<Account>;
  cardTransactions: Table<CardTransaction>;
  holds: Table<Hold>;
  transfers: Table<Transfer>;
  payments: Table<Payment>;
  events: Table<DomainEvent>;
}

/** In-memory table. Rows are cloned on the way in and out so callers must `put` to persist edits. */
export class MemoryTable<T extends { id: string }> implements Table<T> {
  private rows = new Map<string, T>();

  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async put(row: T): Promise<T> {
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async find(pred: (row: T) => boolean): Promise<T | undefined> {
    for (const row of this.rows.values()) if (pred(row)) return structuredClone(row);
    return undefined;
  }

  async list(pred?: (row: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    for (const row of this.rows.values()) if (!pred || pred(row)) out.push(structuredClone(row));
    return out;
  }
}

export function createMemoryStore(): Store {
  return {
    users: new MemoryTable<User>(),
    accounts: new MemoryTable<Account>(),
    cardTransactions: new MemoryTable<CardTransaction>(),
    holds: new MemoryTable<Hold>(),
    transfers: new MemoryTable<Transfer>(),
    payments: new MemoryTable<Payment>(),
    events: new MemoryTable<DomainEvent>(),
  };
}
