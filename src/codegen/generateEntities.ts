import pgStructure, { Db, Table } from "pg-structure";
import { camelCase, constantCase, paramCase, pascalCase } from "change-case";
import { promises as fs } from "fs";
import { Client } from "pg";
import pluralize from "pluralize";
import { code, Code, imp } from "ts-poet";
import TopologicalSort from "topological-sort";
import {
  isEntityTable,
  isEnumTable,
  isJoinTable,
  mapSimpleDbType,
  merge,
  tableToEntityName,
  trueIfResolved,
} from "./utils";
import { SymbolSpec } from "ts-poet/build/SymbolSpecs";
import { newPgConnectionConfig } from "../env";

const columnCustomizations: Record<string, ColumnMetaData> = {};

const Collection = imp("Collection@../src");
const OneToManyCollection = imp("OneToManyCollection@../src");
const EntityOrmField = imp("EntityOrmField@../src");
const EntityManager = imp("EntityManager@../src");
const EntityMetadata = imp("EntityMetadata@../src");
const PrimaryKeySerde = imp("PrimaryKeySerde@../src/serde");
const ManyToOneReference = imp("ManyToOneReference@../src");
const ManyToManyCollection = imp("ManyToManyCollection@../src");
const ForeignKeySerde = imp("ForeignKeySerde@../src/serde");
const Reference = imp("Reference@../src");
const SimpleSerde = imp("SimpleSerde@../src/serde");

export interface CodeGenFile {
  path: string;
  name: string;
  contents: Code | string;
  overwrite: boolean;
}

export interface ColumnMetaData {
  typeConverter?: SymbolSpec;
  fieldType: SymbolSpec | string;
}

/** A map from Enum table name to the rows currently in the table. */
export type EnumRows = Record<string, EnumRow[]>;
export type EnumRow = { id: number; code: string; name: string };

// TODO Make this a config option.
const entitiesDirectory = "./integration";

/** Uses entities and enums from the `db` schema and saves them into our entities directory. */
export async function generateAndSaveEntities(db: Db, enumRows: EnumRows): Promise<void> {
  const files = generateEntities(db, enumRows);
  for await (const file of files) {
    const path = `${file.path}/${file.name}`;
    if (file.overwrite) {
      await fs.writeFile(path, await contentToString(file.contents, file.name));
    } else {
      const exists = await trueIfResolved(fs.access(path));
      if (!exists) {
        await fs.writeFile(path, await contentToString(file.contents, file.name));
      }
    }
  }
}

/** Generates our `${Entity}` and `${Entity}Codegen` files based on the `db` schema. */
export function generateEntities(db: Db, enumRows: EnumRows): CodeGenFile[] {
  const entities = db.tables.filter(isEntityTable).sortBy("name");
  const enums = db.tables.filter(isEnumTable).sortBy("name");

  const entityFiles = entities
    .map(table => {
      const entityName = tableToEntityName(table);
      return [
        {
          path: entitiesDirectory,
          name: `${entityName}Codegen.ts`,
          contents: generateEntityCodegenFile(table, entityName),
          overwrite: true,
        },
        // {
        //   path: entitiesDirectory,
        //   name: `${entityName}.ts`,
        //   contents: generateSubSpec(table, entityName),
        //   overwrite: false,
        // },
      ];
    })
    .reduce(merge, []);

  const enumFiles = enums
    .map(table => {
      const enumName = tableToEntityName(table);
      return [
        {
          path: entitiesDirectory,
          name: `${enumName}.ts`,
          contents: generateEnumSpec(table, enumRows, enumName),
          overwrite: true,
        },
      ];
    })
    .reduce(merge, []);

  const sortedEntities = sortByRequiredForeignKeys(db);
  const metadataFile: CodeGenFile = {
    path: entitiesDirectory,
    name: "./metadata.ts",
    contents: code`${entities.map(table => generateMetadata(sortedEntities, table))}`,
    overwrite: true,
  };

  const entitiesFile: CodeGenFile = {
    path: entitiesDirectory,
    name: "./entities.ts",
    contents: code`
      // This file drives our import order to avoid undefined errors
      // when the subclasses extend the base classes, see:
      // https://medium.com/visual-development/how-to-fix-nasty-circular-dependency-issues-once-and-for-all-in-javascript-typescript-a04c987cf0de
      ${enums.map(table => {
        return `export * from "./${tableToEntityName(table)}";`;
      })}
      ${entities.map(table => {
        return `export * from "./${tableToEntityName(table)}Codegen";`;
      })}
      ${entities.map(table => {
        return `export * from "./${tableToEntityName(table)}";`;
      })}
      export * from "./metadata";
    `,
    overwrite: true,
  };

  const indexFile: CodeGenFile = {
    path: entitiesDirectory,
    name: "./index.ts",
    contents: code`export * from "./entities"`,
    overwrite: false,
  };

  return [...entityFiles, ...enumFiles, entitiesFile, metadataFile, indexFile];
}

function generateEnumSpec(table: Table, enumRows: EnumRows, enumName: string): Code {
  return code`
    export enum ${enumName} {
      ${enumRows[table.name]
        .map(row => {
          return `${pascalCase(row.code)} = '${constantCase(row.code)}'`;
        })
        .join(",")}
    }
  `;
}

/** Creates the placeholder file for our per-entity custom business logic in. */
// function generateSubSpec(table: Table, entityName: string): Code {
//   const baseClass = imp(`${entityName}Codegen@@src/entities/entities`);
//   return code`
//     export type ${entityName}Ref = ${IdentifiedReference}<${entityName}, "id">;
//
//     @${Entity}({ collection: "${table.name}" })
//     export class ${entityName} extends ${baseClass} implements ${IdEntity}<${entityName}> {
//       constructor(em: ${EntityManager}, opts?: Partial<${entityName}>) {
//         super(em, opts);
//       }
//     }
//
//      export interface ${entityName} extends IWrappedEntity<${entityName}, "id"> {}
//   `;
// }

function mapType(tableName: string, columnName: string, dbColumnType: string): ColumnMetaData {
  return (
    columnCustomizations[`${tableName}.${columnName}`] || {
      fieldType: mapSimpleDbType(dbColumnType),
    }
  );
}

function generateMetadata(sortedEntities: string[], table: Table): Code {
  const entityName = tableToEntityName(table);
  const entity = imp(`${entityName}@./entities`);
  const metaName = `${paramCase(entityName)}Meta`;

  const primaryKey = code`
    { fieldName: "id", columnName: "id", dbType: "int", serde: new ${PrimaryKeySerde}("id", "id") },
  `;

  const primitives = table.columns
    .filter(c => !c.isPrimaryKey && !c.isForeignKey && !readOnlyFields.includes(camelCase(c.name)))
    .map(column => {
      const fieldName = camelCase(column.name);
      return code`
      {
        fieldName: "${fieldName}",
        columnName: "${column.name}",
        dbType: "${column.type.name}",
        serde: new ${SimpleSerde}("${fieldName}", "${column.name}"),
      },`;
    });

  const m2o = table.m2oRelations.map(r => {
    const column = r.foreignKey.columns[0];
    const fieldName = camelCase(column.name.replace("_id", ""));
    const otherEntity = tableToEntityName(r.targetTable);
    const otherMeta = `${paramCase(otherEntity)}Meta`;
    return code`
      {
        fieldName: "${fieldName}",
        columnName: "${column.name}",
        dbType: "int",
        serde: new ${ForeignKeySerde}("${fieldName}", "${column.name}", () => ${otherMeta}),
      },
    `;
  });

  return code`
    export const ${metaName}: ${EntityMetadata}<${entity}> = {
      cstr: ${entity},
      type: "${entityName}",
      tableName: "${table.name}",
      columns: [
        ${primaryKey}
        ${primitives}
        ${m2o}
      ],
      order: ${sortedEntities.indexOf(entityName)},
    };
    
    (${entity} as any).metadata = ${metaName};
  `;
}

const readOnlyFields = ["createdAt", "updatedAt"];

/** Creates the base class with the boilerplate annotations. */
function generateEntityCodegenFile(table: Table, entityName: string): Code {
  const entityType = imp(`${entityName}@./entities`);

  // Add the primitives
  const primitives = table.columns
    .filter(c => !c.isPrimaryKey && !c.isForeignKey)
    .map(column => {
      const fieldName = camelCase(column.name);
      const type = mapType(table.name, column.name, column.type.shortName!);
      const getter = code`
        get ${fieldName}(): ${type.fieldType} {
          return this.__orm.data["${fieldName}"];
        }
     `;
      const setter = code`
        set ${fieldName}(${fieldName}: ${type.fieldType}) {
          this.__orm.data["${fieldName}"] = ${fieldName};
          this.__orm.em.markDirty(this);
        }
      `;
      return code`${getter} ${!readOnlyFields.includes(fieldName) ? setter : ""}`;
    });

  // Add ManyToOne
  const m2o = table.m2oRelations.map(r => {
    const column = r.foreignKey.columns[0];
    const fieldName = camelCase(column.name.replace("_id", ""));
    const otherEntityName = tableToEntityName(r.targetTable);
    const otherEntityType = imp(`${otherEntityName}@./entities`);
    const otherFieldName = camelCase(pluralize(entityName));
    return code`
      readonly ${fieldName}: ${Reference}<${entityType}, ${otherEntityType}> = new ${ManyToOneReference}(this, ${otherEntityType}, "${fieldName}", "${otherFieldName}");
    `;
  });

  // Add OneToMany
  const o2m = table.o2mRelations
    // ManyToMany join tables also show up as OneToMany tables in pg-structure
    .filter(r => !isJoinTable(r.targetTable))
    .map(r => {
      const column = r.foreignKey.columns[0];
      // source == parent i.e. the reference of the foreign key column
      // target == child i.e. the table with the foreign key column in it
      const otherEntityName = tableToEntityName(r.targetTable);
      const otherEntityType = imp(`${otherEntityName}@./entities`);
      const otherMeta = imp(`${paramCase(otherEntityName)}Meta@./entities`);
      // I.e. if the other side is `child.project_id`, use children
      const fieldName = camelCase(pluralize(otherEntityName));
      const otherFieldName = camelCase(column.name.replace("_id", ""));
      return code`
       readonly ${fieldName}: ${Collection}<${entityType}, ${otherEntityType}> = new ${OneToManyCollection}(this, ${otherMeta}, "${fieldName}", "${otherFieldName}", "${column.name}");
      `;
    });

  // Add ManyToMany
  const m2m = table.m2mRelations
    // pg-structure is really loose on what it considers a m2m relationship, i.e. any entity
    // that has a foreign key to us, and a foreign key to something else, is automatically
    // considered as a join table/m2m between "us" and "something else". Filter these out
    // by looking for only true join tables, i.e. tables with only id, fk1, and fk2.
    .filter(r => isJoinTable(r.joinTable))
    .map(r => {
      const { foreignKey, targetForeignKey, targetTable } = r;
      // const ownerBasedOnCascade = foreignKey.onDelete === "CASCADE" || targetForeignKey.onDelete === "CASCADE";
      // const isOwner = ownerBasedOnCascade
      //   ? foreignKey.onDelete === "CASCADE"
      //   : foreignKey.columns[0].name < targetForeignKey.columns[0].name;
      const otherEntityName = tableToEntityName(targetTable);
      const otherEntityType = imp(`${otherEntityName}@./entities`);
      const fieldName = camelCase(pluralize(targetForeignKey.columns[0].name.replace("_id", "")));
      const otherFieldName = camelCase(pluralize(foreignKey.columns[0].name.replace("_id", "")));
      return code`
        readonly ${fieldName}: ${Collection}<${entityType}, ${otherEntityType}> = new ${ManyToManyCollection}(
          "${r.joinTable.name}",
          this,
          "${fieldName}",
          "${foreignKey.columns[0].name}",
          ${otherEntityType},
          "${otherFieldName}",
          "${targetForeignKey.columns[0].name}",
        );
      `;
    });

  const metadata = imp(`${paramCase(entityName)}Meta@./entities`);

  return code`
    export class ${entityName}Codegen {
      readonly __orm: ${EntityOrmField};
      
      ${[o2m, m2o, m2m]}
      
      constructor(em: ${EntityManager}) {
        this.__orm = { metadata: ${metadata}, data: {}, em };
        em.register(this);
        //if (opts) {
        //  Object.entries(opts).forEach(([key, value]) => ((this as any)[key] = value));
        //}
      }
        
      get id(): string | undefined {
        return this.__orm.data["id"];
      }
      
      ${primitives}
      
      toString(): string {
        return "${entityName}#" + this.id;
      }
    }
  `;
}

export async function loadEnumRows(db: Db, client: Client): Promise<EnumRows> {
  const promises = db.tables.filter(isEnumTable).map(async table => {
    const result = await client.query(`SELECT * FROM ${table.name} ORDER BY id`);
    const rows = result.rows.map(row => ({ id: row.id, code: row.code, name: row.name } as EnumRow));
    return [table.name, rows] as [string, EnumRow[]];
  });
  return Object.fromEntries(await Promise.all(promises));
}

export async function contentToString(content: Code | string, fileName: string): Promise<string> {
  if (typeof content === "string") {
    return content;
  }
  return await content.toStringWithImports(fileName);
}

/**
 * For now, we insert entities in a deterministic order based on FK dependencies.
 *
 * This will only work with a subset of schemas, so we'll work around that later.
 */
function sortByRequiredForeignKeys(db: Db): string[] {
  const tables = db.tables.filter(isEntityTable);
  const ts = new TopologicalSort<string, Table>(new Map());
  tables.forEach(t => ts.addNode(t.name, t));
  tables.forEach(t => {
    t.m2oRelations.forEach(m2o => {
      if (m2o.foreignKey.columns.every(c => c.notNull)) {
        ts.addEdge(m2o.targetTable.name, t.name);
      }
    });
  });
  return Array.from(ts.sort().values()).map(v => tableToEntityName(v.node));
}

if (require.main === module) {
  (async function() {
    const config = newPgConnectionConfig();
    const db = await pgStructure(config);

    const client = new Client(config);
    await client.connect();
    const enumRows = await loadEnumRows(db, client);
    await client.end();

    await generateAndSaveEntities(db, enumRows);
  })().catch(console.error);
}
