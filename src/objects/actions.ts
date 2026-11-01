import { hashSeed, seededRandom } from '../utils/random';
import { itemLabel } from './items';
import type { ItemStack } from './items';
import type { InteractionAction, InteractionContext } from '../interaction/types';
import type { ObjectArchetype, ObjectState } from './archetypes';

/** Deterministic container contents: the same object always yields the same loot. */
export function rollContainerContents(archetype: ObjectArchetype, objectId: string): ItemStack[] {
  if (!archetype.container) return [];
  const { itemId, min, max } = archetype.container;
  const rng = seededRandom(hashSeed(objectId) ^ 0x9e3779b9);
  const count = min + Math.floor(rng() * (max - min + 1));
  return count > 0 ? [{ itemId, count }] : [];
}

function collectStacks(context: InteractionContext, stacks: readonly ItemStack[]): { taken: number; remaining: ItemStack[] } {
  let taken = 0;
  const remaining: ItemStack[] = [];
  for (const stack of stacks) {
    const result = context.inventory.add(stack.itemId, stack.count);
    taken += result.added;
    if (result.added > 0) {
      context.events.emit('item:collected', {
        objectId: context.objectId, itemId: stack.itemId, count: result.added, total: context.inventory.count(stack.itemId),
      });
    }
    if (result.remaining > 0) remaining.push({ itemId: stack.itemId, count: result.remaining });
  }
  return { taken, remaining };
}

/**
 * Build the interaction actions for an archetype.
 *
 * Each action mutates only `ObjectState` plus the world systems passed in the
 * context (inventory, physics, events). That keeps objects data-driven: new
 * archetypes reuse these behaviours, and new behaviours are added here once
 * rather than inside every object instance.
 */
export function actionsFor(archetype: ObjectArchetype): readonly InteractionAction[] {
  switch (archetype.kind) {
    case 'door':
      return [{
        id: 'toggle',
        label: (state: ObjectState) => (state.open ? 'Close gate' : 'Open gate'),
        holdSeconds: 0.15,
        run: (context) => {
          const open = !context.state.open;
          context.setState({ open });
          return { message: open ? `${archetype.label} opened` : `${archetype.label} closed` };
        },
      }];

    case 'container':
      return [
        {
          id: 'open',
          label: 'Open',
          holdSeconds: 0.2,
          available: (state: ObjectState) => state.opened !== true,
          run: (context) => {
            const contents = rollContainerContents(archetype, context.objectId);
            context.setState({ opened: true, contents });
            return { message: contents.length > 0 ? `${archetype.label} contains supplies` : `${archetype.label} is empty` };
          },
        },
        {
          id: 'take',
          label: (state: ObjectState) => {
            const contents = state.contents ?? [];
            const total = contents.reduce((sum, stack) => sum + stack.count, 0);
            if (total === 0) return 'Nothing to take';
            return `Take ${itemLabel(contents[0]!.itemId)}${total > 1 ? ` ×${total}` : ''}`;
          },
          available: (state: ObjectState) => (state.contents?.length ?? 0) > 0,
          run: (context) => {
            const { taken, remaining } = collectStacks(context, context.state.contents ?? []);
            context.setState({ opened: true, contents: remaining });
            return { message: taken > 0 ? `Collected ${taken} item${taken === 1 ? '' : 's'}` : 'Your pack is full' };
          },
        },
      ];

    case 'pickup':
      return [{
        id: 'take',
        label: `Take ${archetype.label.toLowerCase()}`,
        holdSeconds: 0.25,
        available: (state: ObjectState) => state.collected !== true,
        run: (context) => {
          const pickup = archetype.pickup;
          if (!pickup) return;
          const result = context.inventory.add(pickup.itemId, pickup.count);
          if (result.added <= 0) return { message: 'Your pack is full' };
          context.setState({ collected: true });
          context.events.emit('item:collected', {
            objectId: context.objectId, itemId: pickup.itemId, count: result.added, total: context.inventory.count(pickup.itemId),
          });
          context.remove();
          return { message: `Picked up ${itemLabel(pickup.itemId)}${result.added > 1 ? ` ×${result.added}` : ''}` };
        },
      }];

    case 'switch':
      return [{
        id: 'toggle',
        label: (state: ObjectState) => (state.on ? 'Switch off' : 'Switch on'),
        holdSeconds: 0.12,
        run: (context) => {
          const on = !context.state.on;
          context.setState({ on });
          return { message: `${archetype.label} ${on ? 'energised' : 'isolated'}` };
        },
      }];

    case 'lamp':
      return [{
        id: 'toggle',
        label: (state: ObjectState) => (state.on ? 'Turn off lamp' : 'Turn on lamp'),
        run: (context) => {
          const on = !context.state.on;
          context.setState({ on });
          return { message: on ? 'Lamp lit' : 'Lamp off' };
        },
      }];

    case 'lever':
      return [{
        id: 'pull',
        label: (state: ObjectState) => (state.used ? 'Reset lever' : 'Pull lever'),
        holdSeconds: 0.35,
        run: (context) => {
          const used = !context.state.used;
          context.setState({ used });
          return { message: used ? 'Lever thrown' : 'Lever reset' };
        },
      }];

    case 'valve':
      return [{
        id: 'turn',
        label: 'Turn valve',
        holdSeconds: 0.6,
        run: (context) => {
          const level = ((context.state.level ?? 0) + 1) % 5;
          context.setState({ level });
          return { message: `Valve position ${level}/4` };
        },
      }];

    case 'seat':
      return [
        {
          id: 'sit',
          label: 'Sit down',
          available: (state: ObjectState) => state.seated !== true,
          run: (context) => {
            context.setState({ seated: true, visited: true });
            context.events.emit('player:seated', { objectId: context.objectId });
            return { message: 'Seated. Stand to continue.' };
          },
        },
        {
          id: 'stand',
          label: 'Stand up',
          available: (state: ObjectState) => state.seated === true,
          run: (context) => {
            context.setState({ seated: false });
            context.events.emit('player:stood', { objectId: context.objectId });
            return { message: 'Standing' };
          },
        },
      ];

    case 'sign':
      return [{
        id: 'read',
        label: 'Read sign',
        run: (context) => {
          context.setState({ visited: true });
          return { message: archetype.signText ?? archetype.label };
        },
      }];
  }
}
