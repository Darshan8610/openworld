/**
 * Generic item catalogue and stack type.
 *
 * Nothing here is story content: these are category-level supplies, tools and
 * materials that a future narrative, economy or crafting layer can re-skin.
 */
export const ITEM_DEFINITIONS = {
  'field-ration': { label: 'Field ration', category: 'supply', maxStack: 6, description: 'Sealed travel food.' },
  'water-flask': { label: 'Water flask', category: 'supply', maxStack: 4, description: 'Insulated flask.' },
  'tool-kit': { label: 'Tool kit', category: 'tool', maxStack: 2, description: 'Spanners, driver bits and pliers.' },
  'lantern-cell': { label: 'Lantern cell', category: 'supply', maxStack: 12, description: 'Rechargeable light cell.' },
  'rope-coil': { label: 'Rope coil', category: 'tool', maxStack: 3, description: 'Twenty metres of static line.' },
  'spare-parts': { label: 'Spare parts', category: 'material', maxStack: 20, description: 'Gaskets, hose and fasteners.' },
  'first-aid': { label: 'First-aid pouch', category: 'supply', maxStack: 5, description: 'Dressings and antiseptic.' },
  'survey-tag': { label: 'Survey tag', category: 'collectible', maxStack: 50, description: 'A numbered trail marker.' },
  'fuel-can': { label: 'Fuel can', category: 'supply', maxStack: 4, description: 'Twenty litres, sealed.' },
  'scrap-metal': { label: 'Scrap metal', category: 'material', maxStack: 30, description: 'Salvage stock.' },
} as const;

export type ItemId = keyof typeof ITEM_DEFINITIONS;
export const ITEM_IDS = Object.keys(ITEM_DEFINITIONS) as ItemId[];
export type ItemCategory = (typeof ITEM_DEFINITIONS)[ItemId]['category'];

export interface ItemStack {
  itemId: ItemId;
  count: number;
}

export const isItemId = (value: string): value is ItemId => Object.prototype.hasOwnProperty.call(ITEM_DEFINITIONS, value);
export const itemDefinition = (id: ItemId) => ITEM_DEFINITIONS[id];
export const maxStackFor = (id: ItemId): number => ITEM_DEFINITIONS[id].maxStack;
export const itemLabel = (id: ItemId): string => ITEM_DEFINITIONS[id].label;
