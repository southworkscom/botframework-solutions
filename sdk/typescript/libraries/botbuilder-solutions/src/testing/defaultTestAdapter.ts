/**
 * Copyright(c) Microsoft Corporation.All rights reserved.
 * Licensed under the MIT License.
 */
import { TestAdapter } from 'botbuilder';
import { EventDebuggerMiddleware } from '../middleware';

export class DefaultTestAdapter extends TestAdapter {
    constructor() {
        // tslint:disable-next-line: no-empty
        super(async() => {});
        super.use(new EventDebuggerMiddleware());
    }
}