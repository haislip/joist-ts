import {
  Collection,
  ensureNotDeleted,
  Entity,
  EntityMetadata,
  getEm,
  getMetadata,
  IdOf,
  maybeResolveReferenceToId,
} from "../index";
import { remove } from "../utils";
import { AbstractRelationImpl } from "./AbstractRelationImpl";
import { ManyToOneReference } from "./ManyToOneReference";
import { oneToManyDataLoader } from "../dataloaders/oneToManyDataLoader";

export class OneToManyCollection<T extends Entity, U extends Entity> extends AbstractRelationImpl<U[]>
  implements Collection<T, U> {
  private loaded: U[] | undefined;
  // We don't need to track removedBeforeLoaded, because if a child is removed in our unloaded state,
  // when we load and get back the `child X has parent_id = our id` rows from the db, `loaderForCollection`
  // groups the hydrated rows by their _current parent m2o field value_, which for a removed child will no
  // longer be us, so it will effectively not show up in our post-load `loaded` array.
  private addedBeforeLoaded: U[] = [];
  private isCascadeDelete: boolean;

  constructor(
    // These are public to our internal implementation but not exposed in the Collection API
    public entity: T,
    public otherMeta: EntityMetadata<U>,
    public fieldName: keyof T,
    public otherFieldName: keyof U,
    public otherColumnName: string,
  ) {
    super();
    this.isCascadeDelete = getMetadata(entity).config.__data.cascadeDeleteFields.includes(fieldName as any);
  }

  // opts is an internal parameter
  async load(opts?: { withDeleted?: boolean }): Promise<readonly U[]> {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    if (this.loaded === undefined) {
      if (this.entity.id === undefined) {
        this.loaded = [];
      } else {
        this.loaded = await oneToManyDataLoader(getEm(this.entity), this).load(this.entity.id);
      }
      this.maybeAppendAddedBeforeLoaded();
    }
    return this.filterDeleted(this.loaded, opts);
  }

  async find(id: IdOf<U>): Promise<U | undefined> {
    return (await this.load()).find((u) => u.id === id);
  }

  get get(): U[] {
    return this.filterDeleted(this.doGet(), { withDeleted: false });
  }

  get getWithDeleted(): U[] {
    return this.filterDeleted(this.doGet(), { withDeleted: true });
  }

  private doGet(): U[] {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    if (this.loaded === undefined) {
      if (this.entity.id === undefined) {
        return this.addedBeforeLoaded;
      } else {
        // This should only be callable in the type system if we've already resolved this to an instance
        throw new Error("get was called when not preloaded");
      }
    }
    return this.loaded;
  }

  set(values: U[]): void {
    ensureNotDeleted(this.entity);
    if (this.loaded === undefined) {
      throw new Error("set was called when not loaded");
    }
    // Make a copy for safe iteration
    const loaded = [...this.loaded];
    // Remove old values
    for (const other of loaded) {
      if (!values.includes(other)) {
        this.remove(other);
      }
    }
    for (const other of values) {
      if (!loaded.includes(other)) {
        this.add(other);
      }
    }
  }

  add(other: U): void {
    ensureNotDeleted(this.entity);
    if (this.loaded === undefined) {
      if (!this.addedBeforeLoaded.includes(other)) {
        this.addedBeforeLoaded.push(other);
      }
    } else {
      if (!this.loaded.includes(other)) {
        this.loaded.push(other);
      }
    }
    // This will no-op and mark other dirty if necessary
    this.getOtherRelation(other).set(this.entity);
  }

  // We're not supported remove(other) because that might leave other.otherFieldName as undefined,
  // which we don't know if that's valid or not, i.e. depending on whether the field is nullable.
  remove(other: U, opts: { requireLoaded: boolean } = { requireLoaded: true }) {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    if (this.loaded === undefined && opts.requireLoaded) {
      throw new Error("remove was called when not loaded");
    }
    remove(this.loaded || this.addedBeforeLoaded, other);
    // This will no-op and mark other dirty if necessary
    this.getOtherRelation(other).set(undefined);
  }

  removeAll(): void {
    ensureNotDeleted(this.entity);
    if (this.loaded === undefined) {
      throw new Error("removeAll was called when not loaded");
    }
    for (const other of [...this.loaded]) {
      this.remove(other);
    }
  }

  // internal impl

  setFromOpts(others: U[]): void {
    this.loaded = [];
    others.forEach((o) => this.add(o));
  }

  initializeForNewEntity(): void {
    // Don't overwrite any opts values
    if (this.loaded === undefined) {
      this.loaded = [];
    }
  }

  removeIfLoaded(other: U) {
    if (this.loaded !== undefined) {
      remove(this.loaded, other);
    } else {
      remove(this.addedBeforeLoaded, other);
    }
  }

  async refreshIfLoaded(): Promise<void> {
    // TODO We should remember what load hints have been applied to this collection and re-apply them.
    if (this.loaded !== undefined && this.entity.id !== undefined) {
      this.loaded = await oneToManyDataLoader(getEm(this.entity), this).load(this.entity.id);
    }
  }

  maybeCascadeDelete(): void {
    if (this.isCascadeDelete) {
      this.current({ withDeleted: true }).forEach(getEm(this.entity).delete);
    }
  }

  // We already unhooked all children in our addedBeforeLoaded list; now load the full list if necessary.
  async cleanupOnEntityDeleted(): Promise<void> {
    const current = await this.load({ withDeleted: true });
    current.forEach((other) => {
      const m2o = this.getOtherRelation(other);
      if (maybeResolveReferenceToId(m2o.current()) === this.entity.id) {
        // TODO What if other.otherFieldName is required/not-null?
        m2o.set(undefined);
      }
    });
    this.loaded = [];
    this.addedBeforeLoaded = [];
  }

  private maybeAppendAddedBeforeLoaded(): void {
    if (this.loaded) {
      const newEntities = this.addedBeforeLoaded.filter((e) => !this.loaded?.includes(e));
      // Push on the end to better match the db order of "newer things come last"
      for (const e of newEntities) {
        this.loaded.push(e);
      }
      this.addedBeforeLoaded = [];
    }
  }

  current(opts?: { withDeleted?: boolean }): U[] {
    return this.filterDeleted(this.loaded || this.addedBeforeLoaded, opts);
  }

  public toString(): string {
    return `OneToManyCollection(entity: ${this.entity}, fieldName: ${this.fieldName}, otherType: ${this.otherMeta.type}, otherFieldName: ${this.otherFieldName})`;
  }

  private filterDeleted(entities: U[], opts?: { withDeleted?: boolean }): U[] {
    return opts?.withDeleted === true ? [...entities] : entities.filter((e) => !e.isDeletedEntity);
  }

  /** Returns the other relation that points back at us, i.e. we're `Author.image` and this is `Image.author_id`. */
  private getOtherRelation(other: U): ManyToOneReference<U, T, any> {
    return (other as U)[this.otherFieldName] as any;
  }
}
