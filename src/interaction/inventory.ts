import { ITEM_DEFINITIONS, isItemId, maxStackFor } from '../objects/items';
import type { ItemId, ItemStack } from '../objects/items';
import type { GameEventBus } from '../core/events';

export interface AddResult {
  readonly added: number;
  readonly remaining: number;
  readonly reason?: 'full' | 'stack-limit';
}

/**
 * Player inventory — deliberately generic. It stores stacks, respects per-item
 * stack limits and a global slot budget, and publishes change events so UI,
 * missions and audio can react without owning it.
 */
export class Inventory {
  private readonly slots = new Map<ItemId, number>();

  constructor(private readonly events?: GameEventBus, readonly capacity = 24) {}

  get size(): number { return this.slots.size; }
  get total(): number { let total = 0; for (const count of this.slots.values()) total += count; return total; }

  count(itemId: ItemId): number { return this.slots.get(itemId) ?? 0; }

  stacks(): ItemStack[] {
    return [...this.slots.entries()].map(([itemId, count]) => ({ itemId, count }));
  }

  has(itemId: ItemId, count = 1): boolean { return this.count(itemId) >= count; }

  /** Free space for an item, in units, limited by stack limit and slot budget. */
  freeSpace(itemId: ItemId): number {
    const existing = this.slots.get(itemId);
    const maxStack = maxStackFor(itemId);
    if (existing === undefined) return this.slots.size >= this.capacity ? 0 : maxStack;
    return Math.max(0, maxStack - existing);
  }

  add(itemId: ItemId, count = 1): AddResult {
    if (!isItemId(itemId) || count <= 0) return { added: 0, remaining: Math.max(0, count), reason: 'stack-limit' };
    const space = this.freeSpace(itemId);
    if (space <= 0) return { added: 0, remaining: count, reason: this.slots.size >= this.capacity ? 'full' : 'stack-limit' };
    const added = Math.min(space, count);
    this.slots.set(itemId, this.count(itemId) + added);
    this.publish();
    return { added, remaining: count - added };
  }

  remove(itemId: ItemId, count = 1): number {
    const current = this.count(itemId);
    if (current <= 0 || count <= 0) return 0;
    const removed = Math.min(current, count);
    if (removed === current) this.slots.delete(itemId);
    else this.slots.set(itemId, current - removed);
    if (removed > 0) this.publish();
    return removed;
  }

  clear(): void { this.slots.clear(); this.publish(); }

  /** Restore from a save without emitting intermediate states. */
  restore(stacks: readonly ItemStack[]): void {
    this.slots.clear();
    for (const stack of stacks) {
      if (!isItemId(stack.itemId) || !Number.isFinite(stack.count) || stack.count <= 0) continue;
      this.slots.set(stack.itemId, Math.min(maxStackFor(stack.itemId), Math.floor(stack.count)));
    }
    this.publish();
  }

  label(itemId: ItemId): string { return ITEM_DEFINITIONS[itemId].label; }

  private publish(): void {
    this.events?.emit('inventory:changed', { items: this.stacks(), total: this.total });
  }
}
