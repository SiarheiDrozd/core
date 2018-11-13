import 'reflect-metadata';
import {Container} from 'inversify';

import * as fs from 'fs-extra';
import * as glob from 'glob';
import * as path from 'path';
import * as sinon from 'sinon';
import State from '../state/state';
import {HttpHeaders} from '../middleware/http';
import MocksProcessor from './mocks.processor';
import GlobalState from '../state/global.state';

describe('MocksProcessor', () => {
    let consoleLogFn: sinon.SinonStub;
    let consoleWarnFn: sinon.SinonStub;
    let container: Container;
    let doneFn: sinon.SinonStub;
    let fsReadJsonSyncFn: sinon.SinonStub;
    let globSyncFn: sinon.SinonStub;
    let state: sinon.SinonStubbedInstance<State>;
    let processor: MocksProcessor;

    beforeAll(() => {
        container = new Container();
        doneFn = sinon.stub();
        state = sinon.createStubInstance(State);

        container.bind('State').toConstantValue(state);
        container.bind('MocksProcessor').to(MocksProcessor);

        consoleWarnFn = sinon.stub(console, 'warn');
        consoleLogFn = sinon.stub(console, 'log');
        fsReadJsonSyncFn = sinon.stub(fs, 'readJsonSync');
        globSyncFn = sinon.stub(glob, 'sync');

        processor = container.get<MocksProcessor>('MocksProcessor');
    });

    describe('process', () => {
        beforeAll(() => {
            (state as any)._mocks = [];
            (state as any)._defaults = {};
            (state as any)._global = new GlobalState();
            globSyncFn.returns([
                'mock/minimal-json-request.mock.json',
                'mock/minimal-binary-request.mock.json',
                'mock/full-request.mock.json',
                'mock/duplicate-request.mock.json']);
            fsReadJsonSyncFn.onCall(0).returns({
                name: 'minimal-json-request',
                request: { url: 'minimal/json/url', method: 'GET' },
                responses: { 'minimal-json-response': {} }
            });
            fsReadJsonSyncFn.onCall(1).returns({
                name: 'minimal-binary-request',
                request: { url: 'minimal/binary/url', method: 'GET' },
                responses: { 'minimal-binary-response': { file: 'some.pdf' } }
            });
            fsReadJsonSyncFn.onCall(2).returns({
                name: 'full-request',
                isArray: true,
                delay: 1000,
                request: {
                    url: 'full/url',
                    method: 'GET',
                    headers: { 'Cache-control': 'no-store' },
                    body: { 'uuid': '\\d+' }
                },
                responses: {
                    'full-response': {
                        status: 404,
                        data: [{ 'a': 'a' }],
                        headers: { 'Content-type': 'application/something' },
                        statusText: 'oops',
                        default: true
                    },
                    'another-full-response': {
                        status: 500,
                        data: [{ 'a': 'a' }],
                        headers: { 'Content-type': 'application/something' },
                        file: 'some.pdf',
                        statusText: 'oops',
                        default: false
                    }
                }
            });
            fsReadJsonSyncFn.onCall(3).returns({
                name: 'minimal-json-request',
                request: { url: 'duplicate/url', method: 'GET' },
                responses: { 'duplicate-response': {} }
            });
        });

        describe('by default', () => {
            beforeAll(() => {
                processor.process({ src: 'src' });
            });

           it('processes each mock', () => {
                sinon.assert.calledWith(globSyncFn,
                    '**/*.mock.json', {
                        cwd: 'src', root: '/'
                    }
                );
                sinon.assert.calledWith(fsReadJsonSyncFn, path.join('src', 'mock/minimal-json-request.mock.json'));
                sinon.assert.calledWith(fsReadJsonSyncFn, path.join('src', 'mock/minimal-binary-request.mock.json'));
                sinon.assert.calledWith(fsReadJsonSyncFn, path.join('src', 'mock/full-request.mock.json'));
                sinon.assert.calledWith(fsReadJsonSyncFn, path.join('src', 'mock/duplicate-request.mock.json'));
            });

            it('overrides a duplicate mock', () => {
                sinon.assert.calledWith(consoleWarnFn, `Mock with identifier 'minimal-json-request' already exists. Overwriting existing mock.`);
                expect(Object.keys(state.mocks[0].responses)).toEqual(['duplicate-response']);
            });

            it('sets the defaults', () =>
                expect(state.defaults).toEqual({
                    'minimal-json-request': { scenario: 'passThrough', echo: false, delay: 0 },
                    'minimal-binary-request': { scenario: 'passThrough', echo: false, delay: 0 },
                    'full-request': { scenario: 'full-response', echo: false, delay: 1000 }
                }));

            it('sets the global mocks', () =>
                expect(state.global.mocks).toEqual({
                    'minimal-json-request': { scenario: 'passThrough', echo: false, delay: 0 },
                    'minimal-binary-request': { scenario: 'passThrough', echo: false, delay: 0 },
                    'full-request': { scenario: 'full-response', echo: false, delay: 1000 }
                }));

            it('updates the mocks with default values', () => {
                consoleLogFn.callThrough();
                expect(state.mocks[0].responses).toEqual({
                    'duplicate-response': {
                        status: 200, // default is status ok => 200
                        data: {}, // default if isArray is empty of false
                        headers: HttpHeaders.CONTENT_TYPE_APPLICATION_JSON // default if no binary file is specified

                    }
                });
                expect(state.mocks[1].responses).toEqual({
                    'minimal-binary-response': {
                        status: 200, // default is status ok => 200
                        data: {}, // default if isArray is empty of false
                        headers: HttpHeaders.CONTENT_TYPE_BINARY, // default if a binary file is specified
                        file: 'some.pdf'
                    }
                });
                expect(state.mocks[2].responses).toEqual({
                    'full-response': {
                        status: 404,
                        statusText: 'oops',
                        default: true,
                        data: [{ a: 'a' }],
                        headers: { 'Content-type': 'application/something' } // does not add the default headers if specified
                    },
                    'another-full-response': {
                        status: 500,
                        statusText: 'oops',
                        data: [{ a: 'a' }],
                        headers: { 'Content-type': 'application/something' }, // does not add the default headers if specified
                        file: 'some.pdf',
                        default: false
                    }
                });
            });

            it('processes unique mocks', () =>
                sinon.assert.calledWith(consoleLogFn, `Processed 3 unique mocks.`));

            afterAll(() => {
                consoleLogFn.reset();
                consoleWarnFn.reset();
                fsReadJsonSyncFn.reset();
                globSyncFn.reset();
            });
        });

        describe('with full processing options', () => {
            beforeAll(() => {
                globSyncFn.returns([]);
                processor.process({ src: 'src', patterns: { mocks: '**/*.mymock.json' } });
            });
            it('processes each mock', () => {
                sinon.assert.calledWith(globSyncFn,
                    '**/*.mymock.json', {
                        cwd: 'src', root: '/'
                    }
                );
            });
        });
    });

    afterAll(() => {
        consoleLogFn.restore();
        consoleWarnFn.restore();
        fsReadJsonSyncFn.restore();
        globSyncFn.restore();
    });
});