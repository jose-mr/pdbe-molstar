import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { isPlainObject } from 'molstar/lib/mol-util/object';
import { BehaviorSubject } from 'rxjs';
import { PreemptiveQueue, combineUrl, distinct } from '../../helpers';


const LOAD_CAMERA_ORIENTATION = true;


export interface StateGalleryData {
    entity?: {
        [entityId: string]: {
            image: Image[],
            database?: {
                [databaseName: string]: {
                    [domainId: string]: {
                        image: Image[],
                    },
                },
            },
        },
    },
    assembly?: {
        [assemblyId: string]: {
            image: Image[],
            preferred?: boolean,
        },
    },
    entry?: {
        all?: {
            image: Image[],
        },
        bfactor?: {
            image: Image[],
        },
        ligands?: {
            [compId: string]: {
                image: Image[],
                entity?: string,
                number_of_instances?: number,
            },
        },
        mod_res?: {
            [compId: string]: {
                image: Image[],
            },
        },
    },
    validation?: {
        geometry?: {
            deposited?: {
                image: Image[],
            },
        },
    },
    image_suffix?: string[],
    last_modification?: string,
}
const ImageCategory = ['Entry', 'Assemblies', 'Entities', 'Ligands', 'Modified residues', 'Domains', 'Miscellaneous'] as const;
type ImageCategory = typeof ImageCategory[number]

export interface Image {
    filename: string,
    alt: string,
    description: string,
    clean_description: string,
    category?: ImageCategory,
    simple_title?: string,
}


export class StateGalleryManager {
    public readonly images: Image[];
    public readonly requestedStateName = new BehaviorSubject<string | undefined>(undefined);
    public readonly loadedStateName = new BehaviorSubject<string | undefined>(undefined);

    private constructor(
        public readonly plugin: PluginContext,
        public readonly serverUrl: string,
        public readonly entryId: string,
        public readonly data: StateGalleryData | undefined,
    ) {
        this.images = removeWithSuffixes(listImages(data, true), ['_side', '_top']); // TODO allow suffixes by a parameter, sort by parameter
    }

    static async create(plugin: PluginContext, serverUrl: string, entryId: string) {
        const data = await getData(plugin, serverUrl, entryId);
        if (data === undefined) {
            console.error(`StateGalleryManager failed to get data for entry ${entryId}`);
        }
        return new this(plugin, serverUrl, entryId, data);
    }

    private async _load(filename: string): Promise<string> {
        let snapshot = await this.getSnapshot(filename);
        snapshot = removeDataFromSnapshot(snapshot, { removeBackground: true, removeCamera: !LOAD_CAMERA_ORIENTATION });
        const file = new File([snapshot], `${filename}.molj`);
        await PluginCommands.State.Snapshots.OpenFile(this.plugin, { file });
        // await this.plugin.managers.snapshot.setStateSnapshot(JSON.parse(data));
        if (!LOAD_CAMERA_ORIENTATION) {
            this.plugin.canvas3d?.commit();
            await PluginCommands.Camera.Reset(this.plugin);
        }
        this.loadedStateName.next(filename);
        return filename;
    }
    private readonly loader = new PreemptiveQueue((filename: string) => this._load(filename));
    async load(filename: string) {
        this.requestedStateName.next(filename);
        this.loadedStateName.next(undefined);
        const result = await this.loader.requestRun(filename);
        if (result.status === 'completed') {
            this.loadedStateName.next(filename);
        }
        return result;
    }

    private readonly cache: { [filename: string]: string } = {};
    private async fetchSnapshot(filename: string): Promise<string> {
        const url = combineUrl(this.serverUrl, `${filename}.molj`);
        const data = await this.plugin.runTask(this.plugin.fetch({ url, type: 'string' }));
        return data;
    }
    async getSnapshot(filename: string): Promise<string> {
        return this.cache[filename] ??= await this.fetchSnapshot(filename);
    }
}


async function getData(plugin: PluginContext, serverUrl: string, entryId: string) {
    const url = combineUrl(serverUrl, entryId + '.json');
    try {
        const text = await plugin.runTask(plugin.fetch(url));
        const data = JSON.parse(text);
        return data[entryId];
    } catch {
        return undefined;
    }
}

function listImages(data: StateGalleryData | undefined, byCategory: boolean = false): Image[] {
    if (byCategory) {
        const out: Image[] = [];

        // Entry
        // out.push(...data?.entry?.all?.image ?? []);
        for (const img of data?.entry?.all?.image ?? []) {
            const title = img.filename.includes('_chemically_distinct_molecules')
                ? 'Deposited model (color by entity)'
                : img.filename.includes('_chain')
                    ? 'Deposited model (color by chain)'
                    : undefined;
            out.push({ ...img, category: 'Entry', simple_title: title });
        }
        // Validation
        // out.push(...data?.validation?.geometry?.deposited?.image ?? []);
        for (const img of data?.validation?.geometry?.deposited?.image ?? []) {
            out.push({ ...img, category: 'Entry', simple_title: 'Geometry validation' });
        }
        // Bfactor
        // out.push(...data?.entry?.bfactor?.image ?? []);
        for (const img of data?.entry?.bfactor?.image ?? []) {
            out.push({ ...img, category: 'Entry', simple_title: 'B-factor' });
        }
        // Assembly
        const assemblies = data?.assembly;
        for (const ass in assemblies) {
            // out.push(...assemblies[ass].image);
            for (const img of assemblies[ass].image ?? []) {
                const title = img.filename.includes('_chemically_distinct_molecules')
                    ? `Assembly ${ass} (color by entity)`
                    : img.filename.includes('_chain')
                        ? `Assembly ${ass} (color by chain)`
                        : undefined;
                out.push({ ...img, category: 'Assemblies', simple_title: title });
            }
        }
        // Entity
        const entities = data?.entity;
        for (const entity in entities) {
            // out.push(...entities[entity].image);
            for (const img of entities[entity].image ?? []) {
                out.push({ ...img, category: 'Entities', simple_title: `Entity ${entity}` });
            }
        }
        // Ligand
        const ligands = data?.entry?.ligands;
        for (const ligand in ligands) {
            // out.push(...ligands[ligand].image);
            for (const img of ligands[ligand].image ?? []) {
                out.push({ ...img, category: 'Ligands', simple_title: `Ligand environment for ${ligand}` });
            }
        }
        // Modres
        const modres = data?.entry?.mod_res;
        for (const res in modres) {
            // out.push(...modres[res].image);
            for (const img of modres[res].image ?? []) {
                out.push({ ...img, category: 'Modified residues', simple_title: `Modified residue ${res}` });
            }
        }
        // Domain
        for (const entity in entities) {
            const dbs = entities[entity].database;
            for (const db in dbs) {
                const domains = dbs[db];
                for (const domain in domains) {
                    // out.push(...domains[domain].image);
                    for (const img of domains[domain].image ?? []) {
                        out.push({ ...img, category: 'Domains', simple_title: `${db} ${domain} in entity ${entity}` });
                    }
                }
            }
        }

        // Any other potential images not caught in categories above
        pushImages(out, data);
        return distinct(out, img => img.filename);
    } else {
        return pushImages([], data);
    }
}

function pushImages(out: Image[], data: any): Image[] {
    if (isPlainObject(data)) {
        for (const key in data) {
            const value = data[key];
            if (key === 'image' && Array.isArray(value)) {
                out.push(...value);
            } else {
                pushImages(out, value);
            }
        }
    }
    return out;
}

function removeWithSuffixes(images: Image[], suffixes: string[]): Image[] {
    return images.filter(img => !suffixes.some(suffix => img.filename.endsWith(suffix)));
}

function removeDataFromSnapshot(snapshot: string, options: { removeBackground?: boolean, removeCamera?: boolean }) {
    const json = JSON.parse(snapshot);
    if (json.entries) {
        for (const entry of json.entries) {
            if (entry.snapshot) {
                if (options.removeBackground) delete entry.snapshot.canvas3d;
                if (options.removeCamera) delete entry.snapshot.camera;
            }
        }
    }
    return JSON.stringify(json);
}
