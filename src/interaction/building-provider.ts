import type { BuildingInteraction } from '../world/buildings/types';
import type { InteractionProvider } from './types';

/**
 * Phase wiring — on-foot adapter for building bindings (doors and similar).
 *
 * `BuildingRuntime` owns the door state, enforces range/cooldown/occlusion in
 * `interact()` and updates its collision collider; this wrapper only speaks
 * the interaction registry's language so the player gets the same prompt and
 * hold-to-confirm flow as world objects. Nothing is persisted here — the
 * building state store already is.
 */
export function buildingInteractionProvider(
  interaction: BuildingInteraction,
  isOpen: (interactionId: string) => boolean,
): InteractionProvider {
  return {
    id: interaction.id,
    archetype: { key: 'building-door', label: 'Building door' },
    centre: interaction.position,
    radius: 1.1,
    range: interaction.range,
    targetLabel: 'Door',
    persistence: 'world',
    actions: () => [{
      id: 'toggle',
      // The runtime label already flips between "Open …" and "Close …".
      label: () => interaction.label(),
      key: 'E',
      holdSeconds: 0.3,
      run: (context) => {
        const actor = context.actor.position;
        const ok = interaction.interact({ x: actor.x, y: actor.y, z: actor.z });
        return ok ? undefined : { message: 'The door will not move right now.' };
      },
    }],
    state: () => ({ open: isOpen(interaction.id) }),
    // The building runtime owns door state and its collider; never patch it
    // through the generic object-state path.
    setState: () => {},
    remove: () => {},
  };
}
