import type { VehicleController } from './controllers/controller';
import { WheeledController } from './controllers/wheeled';
import { MotorcycleController } from './controllers/motorcycle';
import { AircraftController } from './controllers/aircraft';
import { HelicopterController } from './controllers/helicopter';
import { WatercraftController } from './controllers/watercraft';
import { SailboatController } from './controllers/sailboat';
import { SubmarineController } from './controllers/submarine';
import type { VehicleSpec } from './types';

/**
 * The one place a vehicle class maps to its physics model.
 *
 * Keeping this a single exhaustive switch is deliberate: adding a vehicle
 * family is a compile error here until its controller exists, which is what
 * stops a new category from silently falling back to car physics.
 */
export function createController(spec: VehicleSpec): VehicleController {
  switch (spec.vehicleClass) {
    case 'wheeled': return new WheeledController(spec);
    case 'motorcycle': return new MotorcycleController(spec);
    case 'aircraft': return new AircraftController(spec);
    case 'helicopter': return new HelicopterController(spec);
    case 'watercraft': return new WatercraftController(spec);
    case 'sailboat': return new SailboatController(spec);
    case 'submarine': return new SubmarineController(spec);
    default: {
      const exhaustive: never = spec.vehicleClass;
      throw new Error(`No controller for vehicle class "${String(exhaustive)}"`);
    }
  }
}
