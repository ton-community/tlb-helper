import BN from "bn.js";
import { Slice, Cell, beginCell, Address, Builder, serializeDict, parseDict } from "ton";

export type LoadOpts = {
    lvalue: boolean
    consume: boolean
};

export class Type<A> {
    readonly _A!: A;

    constructor(
        readonly name: string,
        readonly encode: (value: A, to: Builder) => void,
        readonly decode: (slice: Slice) => A,
        readonly funcType: string,
        readonly store: (value: string) => string,
        readonly load: (slice: string, opts: LoadOpts) => string,
        readonly consumesAll: boolean = false,
    ) {}

    innerStructs(): StructType<any>[] {
        return [];
    }

    doLoad = (slice: string, opts?: Partial<LoadOpts>) => {
        const useOpts: LoadOpts = {
            lvalue: true,
            consume: true,
            ...opts
        };

        if (useOpts.consume && !useOpts.lvalue) {
            throw new Error('Cannot consume a non lvalue slice');
        }

        return this.load(slice, useOpts);
    }
}

export type Mixed = Type<any>;

export type TypeOf<T extends Mixed> = T['_A'];

export const slice = new Type<Slice>(
    'Slice',
    (value: Slice, to: Builder) => to.storeCellCopy(value.toCell()),
    (slice: Slice) => slice.clone(),
    'slice',
    (value: string) => `store_slice(${value})`,
    (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~consume_slice()` : slice,
    true,
);

export const cell = new Type<Cell>(
    'Cell',
    (value: Cell, to: Builder) => to.storeCellCopy(value),
    (slice: Slice) => slice.toCell(),
    'cell',
    (value: string) => `store_slice(${value}.begin_parse())`,
    (slice: string, opts: LoadOpts) => `begin_cell().store_slice(${opts.consume ? `${slice}~consume_slice()` : slice}).end_cell()`,
    true,
);

export class RefType<T> extends Type<T> {
    constructor(readonly inner: Type<T>) {
        super(
            'Ref: ' + inner.name,
            (value: T, to: Builder) => {
                const b = beginCell();
                inner.encode(value, b);
                to.storeRef(b.endCell());
            },
            (slice: Slice) => inner.decode(slice.readRef()),
            inner.funcType,
            (value: string) => `store_ref(begin_cell().${inner.store(value)}.end_cell())`,
            (slice: string, opts: LoadOpts) => {
                const ref = opts.consume ? `${slice}~load_ref().begin_parse()` : `${slice}.preload_ref().begin_parse()`;
                return inner.load(ref, {
                    ...opts,
                    lvalue: false,
                    consume: false,
                });
            },
        );
    }

    innerStructs(): StructType<any>[] {
        return this.inner.innerStructs();
    }
}

export function ref<T>(inner: Type<T>): RefType<T> {
    return new RefType(inner);
}

export const address = new Type<Address>(
    'Address',
    (value: Address, to: Builder) => to.storeAddress(value),
    (slice: Slice) => slice.readAddressInternal(),
    'slice',
    (value: string) => `store_slice(${value})`,
    (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~load_msg_addr()` : `${slice}.preload_msg_addr()`,
);

const dictSerializer = <T>(type: Type<T>) => (value: T, cell: Cell) => {
    const b = beginCell();
    type.encode(value, b);
    cell.writeCell(b.endCell());
};

// Keys are in base 10
export type Dictionary<V> = Type<Map<string, V>>;

export class DictionaryType<T> extends Type<Map<string, T>> {
    constructor(readonly inner: Type<T>, readonly keyLength: number) {
        super(
            'Dictionary: ' + inner.name,
            (value: Map<string, T>, to: Builder) => {
                if (value.size === 0) throw new Error('Cannot encode empty map as dictionary. Use optDictionary instead.');

                to.storeCellCopy(serializeDict(value, keyLength, dictSerializer(inner)));
            },
            (slice: Slice) => parseDict(slice, keyLength, inner.decode),
            'cell',
            (value: string) => `store_slice(${value}.begin_parse())`,
            (slice: string, opts: LoadOpts) => `begin_cell().store_slice(${opts.consume ? `${slice}~consume_slice()` : slice}).end_cell()`,
            true,
        );
    }

    innerStructs(): StructType<any>[] {
        return this.inner.innerStructs();
    }
}

export function dictionary<T>(inner: Type<T>, keyLength: number): Dictionary<T> {
    // todo check bits

    return new DictionaryType<T>(inner, keyLength);
}

// Keys are in base 10
export type OptDictionary<V> = Type<Map<string, V> | null>;

export class OptDictionaryType<T> extends Type<Map<string, T> | null> {
    constructor(readonly inner: Type<T>, readonly keyLength: number) {
        super(
            'OptDictionary: ' + inner.name,
            (value: Map<string, T> | null, to: Builder) => {
                if (value?.size === 0) value = null;
                
                to.storeDict(value === null ? null : serializeDict(value, keyLength, dictSerializer(inner)));
            },
            (slice: Slice) => slice.readOptDict(keyLength, inner.decode),
            'cell',
            (value: string) => `store_dict(${value})`,
            (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~load_dict()` : `${slice}.preload_dict()`,
        );
    }

    innerStructs(): StructType<any>[] {
        return this.inner.innerStructs();
    }
}

export function optDictionary<T>(inner: Type<T>, keyLength: number): OptDictionary<T> {
    // todo check bits

    return new OptDictionaryType(inner, keyLength);
}

const checkBits = (bits: number, max: number, type: string) => {
    if (bits <= 0) throw new Error(`Cannot create ${type} with less than or zero bits`);
    if (bits > max) throw new Error(`Cannot create ${type} with more than 257 bits`);
    if (!Number.isInteger(bits)) throw new Error(`Cannot create ${type} with non-integer amount of bits`);
}

export function uint(bits: number): Type<BN> {
    checkBits(bits, 257, 'Uint');

    return new Type<BN>(
        'Uint' + bits,
        (value: BN, to: Builder) => to.storeUint(value, bits),
        (slice: Slice) => slice.readUint(bits),
        'int',
        (value: string) => `store_uint(${value}, ${bits})`,
        (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~load_uint(${bits})` : `${slice}.preload_uint(${bits})`,
    );
}

export function int(bits: number): Type<BN> {
    checkBits(bits, 257, 'Int');

    return new Type<BN>(
        'Int' + bits,
        (value: BN, to: Builder) => to.storeInt(value, bits),
        (slice: Slice) => slice.readInt(bits),
        'int',
        (value: string) => `store_int(${value}, ${bits})`,
        (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~load_int(${bits})` : `${slice}.preload_int(${bits})`,
    );
}

export const bool = int(1);

export const coins = new Type<BN>(
    'Coins',
    (value: BN, to: Builder) => to.storeCoins(value),
    (slice: Slice) => slice.readCoins(),
    'int',
    (value: string) => `store_coins(${value})`,
    (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~load_coins()` : `${slice}.preload_coins()`,
);

export type EitherSameValue<T> = {
    bit: boolean
    value: T
};

export class EitherSameType<T> extends Type<EitherSameValue<T>> {
    private _innerStructs: StructType<any>[];

    constructor(zero: Type<T>, one: Type<T>, storeAs: boolean) {
        if (zero.funcType !== one.funcType) throw new Error('Either zero and one func types do not align');

        super(
            `Either: (${zero})/(${one})`,
            (value: EitherSameValue<T>, to: Builder) => {
                if (value.bit) {
                    to.storeUint(1, 1);
                    one.encode(value.value, to);
                } else {
                    to.storeUint(0, 1);
                    zero.encode(value.value, to);
                }
            },
            (slice: Slice) => {
                const bit = slice.readBit();
                const value = bit ? one.decode(slice) : zero.decode(slice);
                return { bit, value };
            },
            zero.funcType,
            (value: string) => storeAs ? one.store(value) : zero.store(value),
            (slice: string, opts: LoadOpts) => opts.consume
                ? `${slice}~load_uint(1) ? ${one.load(slice, opts)} : ${zero.load(slice, opts)}`
                : `${slice}.preload_uint(1) ? ${one.load(`${slice}.skip_bits(1)`, { ...opts, lvalue: false })} : ${zero.load(`${slice}.skip_bits(1)`, { ...opts, lvalue: false })}`,
        );

        this._innerStructs = Array.from(new Set([...zero.innerStructs(), ...one.innerStructs()]));
    }

    innerStructs(): StructType<any>[] {
        return this._innerStructs;
    }
}

export function eitherSame<T>(zero: Type<T>, one: Type<T>, storeAs: boolean): Type<EitherSameValue<T>> {
    return new EitherSameType(zero, one, storeAs);
}

export function maybeRef(inner: Type<Cell>): Type<Cell | null> {
    if (inner.funcType !== 'cell') throw new Error('Cannot construct maybe ref with a non-cell func type');

    return new Type<Cell | null>(
        'Maybe: ' + inner.name,
        (value: Cell | null, to: Builder) => {
            if (value === null) {
                to.storeRefMaybe(null);
                return;
            }

            const b = beginCell();
            inner.encode(value, b);
            to.storeRefMaybe(b.endCell());
        },
        (slice: Slice) => slice.readBit() ? inner.decode(slice.readRef()) : null,
        'cell',
        (value: string) => `store_maybe_ref(begin_cell().${inner.store(value)}.end_cell())`,
        (slice: string, opts: LoadOpts) => opts.consume
            ? `${inner.load(`${slice}~load_dict().begin_parse()`, { ...opts, lvalue: false, consume: false })}`
            : `${inner.load(`${slice}.preload_dict().begin_parse()`, { ...opts, lvalue: false })}`,
    );
}

export interface Props {
    [key: string]: Mixed
}

export type Struct<P extends Props> = {
    [K in keyof P]: TypeOf<P[K]>
}

const checkKeys = <P extends Props>(props: P, keys: string[]) => {
    if (keys.length !== Object.keys(props).length) return false;
    const p: Partial<P> = { ...props };
    for (const k of keys) {
        if (p[k] === undefined) {
            return false;
        }
        (p as any)[k] = undefined;
    }
    return true;
}

const checkConsumes = <P extends Props>(props: P, keys: string[]) => {
    for (let i = 0; i < keys.length - 1; i++) {
        if (props[keys[i]].consumesAll) throw new Error(`Prop ${keys[i]} consumes whole cell but is not last`);
    }
};

export class StructType<P extends Props> extends Type<Struct<P>> {
    readonly isStruct: boolean = true;

    private _innerStructs: StructType<any>[];

    constructor(name: string, readonly props: P, readonly keys: string[]) {
        if (!checkKeys(props, keys)) throw new Error('Not all keys or duplicate keys are present in the keys array');
        checkConsumes(props, keys);
        super(
            name,
            (value: Struct<P>, to: Builder) => {
                for (const key of keys) {
                    props[key].encode(value[key], to);
                }
            },
            (slice: Slice) => {
                const s: { [x: string]: any } = {};
                for (const key of keys) {
                    s[key] = props[key].decode(slice);
                }
                return s as any;
            },
            '(' + keys.map(k => props[k].funcType).join(', ') + ')',
            (value: string) => `store_builder(pack_${name}(${value}))`,
            (slice: string, opts: LoadOpts) => opts.consume ? `${slice}~unpack_${name}()` : `unpack_${name}_only(${slice})`,
        );
        
        this._innerStructs = [];
        for (const key of keys) {
            const p = props[key];
            this._innerStructs.push(...p.innerStructs());
        }
        this._innerStructs = [...Array.from(new Set(this._innerStructs)), this];
    }

    pack() {
        return this.keys.map(k => '\n        .' + this.props[k].store(k)).join('');
    }

    unpack(slice: string) {
        return '(\n' + this.keys.map((k, i) => '        ' + this.props[k].doLoad(slice) + `${i < this.keys.length - 1 ? ',' : ''} ;; ${k}`).join('\n') + '\n    )';
    }

    innerStructs(): StructType<any>[] {
        return this._innerStructs;
    }

    private processGlobal(prefix: string, vars: string[], types: { [v: string]: string }, tensor: string[]) {
        for (const key of this.keys) {
            const p = this.props[key];
            const ins = p.innerStructs();
            if (ins.length === 0) {
                const vn = prefix + key;
                if (vn in types) {
                    throw new Error('Duplicate variable: ' + vn);
                }
                vars.push(vn);
                types[vn] = p.funcType;
                tensor.push(vn);
            } else {
                const it: string[] = [];
                for (const s of ins) {
                    s.processGlobal(prefix + key + '_', vars, types, it);
                }
                tensor.push(`(${it.join(', ')})`);
            }
        }
    }

    global(prefix: string) {
        const vars: string[] = [];
        const types: { [v: string]: string } = {};
        const tensor: string[] = [];
        this.processGlobal(prefix, vars, types, tensor);
        return { vars, types, tensor };
    }
}

export function struct<P extends Props>(name: string, props: P, keys: string[]) {
    return new StructType<P>(name, props, keys);
}

function funcPackSignature(struct: StructType<any>) {
    return `builder pack_${struct.name}(${struct.keys.map(k => `${struct.props[k].funcType} ${k}`).join(', ')})`;
}

function funcPackOne(struct: StructType<any>) {
    return `${funcPackSignature(struct)} {
    return begin_cell()${struct.pack()};
}`;
}

function funcUnpackSignature(struct: StructType<any>) {
    return `(slice, ${struct.funcType}) unpack_${struct.name}(slice s)`;
}

function funcUnpackOne(struct: StructType<any>) {
    return `${funcUnpackSignature(struct)} {
    var r = ${struct.unpack('s')};
    return (s, r);
}`;
}

function funcUnpackOnlySignature(struct: StructType<any>) {
    return `${struct.funcType} unpack_${struct.name}_only(slice s)`;
}

function funcUnpackOnlyOne(struct: StructType<any>) {
    return `${funcUnpackOnlySignature(struct)} {
    return ${struct.unpack('s')};
}`;
}

export function funcStorage(opts: {
    structs: StructType<any>[],
    global?: {
        struct: StructType<any>,
        prefix?: string,
    },
}): string {
    const allStructs = [...opts.structs];
    if (opts.global) {
        allStructs.push(opts.global.struct);
    }
    const allUsedStructs = Array.from(new Set(allStructs.map(s => s.innerStructs()).flat()));

    let ret = '';

    const gpfx = opts.global?.prefix ?? 'ctx_';
    const g = opts.global ? opts.global.struct.global(gpfx) : undefined;

    if (g) {
        ret += g.vars.map(v => `global ${g.types[v]} ${v};`).join('\n') + '\n\n';
    }

    for (const s of allUsedStructs) {
        ret += funcPackSignature(s) + ';\n';
        ret += funcUnpackSignature(s) + ';\n';
        ret += funcUnpackOnlySignature(s) + ';\n';
    }

    ret += '\n';

    if (g) {
        const tg = opts.global!.struct.global('temp_' + gpfx);

        ret += `() save_data() impure {
    set_data(pack_${opts.global!.struct.name}(${g.tensor.join(', ')}).end_cell());
}

() load_data() impure {
    var (${tg.tensor.join(', ')}) = unpack_${opts.global!.struct.name}_only(get_data().begin_parse());
    ${g.vars.map(v => `${v} = temp_${v};`).join('\n    ')}
}\n\n`;
    }

    for (const s of allUsedStructs) {
        ret += funcPackOne(s) + '\n' + funcUnpackOne(s) + '\n' + funcUnpackOnlyOne(s) + '\n\n';
    }

    return ret;
}