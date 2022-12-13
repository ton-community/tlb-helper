import { compileFunc } from '@ton-community/func-js';
import * as t from '../src';
import { readFileSync } from 'fs';

describe('storage', () => {
    it('should create storage file and compile', async () => {
        const royalty = t.struct('royalty', {
            base: t.uint(32),
            factor: t.uint(32),
            enabled: t.bool,
        }, ['base', 'factor', 'enabled']);
        
        const storage = t.struct('storage', {
            admin: t.address,
            royalty: t.ref(royalty),
            random_dict: t.optDictionary(t.slice, 32),
        }, ['admin', 'royalty', 'random_dict']);
        
        const source = '#include "stdlib.fc";\n\n' + t.funcStorage({
            structs: [],
            global: {
                struct: storage,
            }
        }) + '() recv_internal() impure { load_data(); save_data(); }';

        const cr = await compileFunc({
            sources: (path: string) => {
                if (path === 'source.fc') return source;
                return readFileSync(path).toString();
            },
            entryPoints: ['source.fc'],
        });

        if (cr.status === 'error') throw new Error(cr.message);
    })
})