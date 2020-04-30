/**
 * Copyright(c) Microsoft Corporation.All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ActivityTypes,
    BotFrameworkAdapter,
    BotFrameworkAdapterSettings,
    BotTelemetryClient,
    ConversationState,
    ShowTypingMiddleware,
    TranscriptLoggerMiddleware,
    TranscriptStore,
    TurnContext } from 'botbuilder';
import { AzureBlobTranscriptStore } from 'botbuilder-azure';
import {
    EventDebuggerMiddleware,
    FeedbackMiddleware,
    ISkillManifest,
    LocaleTemplateManager,
    SetLocaleMiddleware, 
    SetSpeakMiddleware,
    FeedbackOptions} from 'bot-solutions';
import { TelemetryInitializerMiddleware } from 'botbuilder-applicationinsights';
import { IBotSettings } from '../services/botSettings.js';
import { inject } from 'inversify';
import { TYPES } from '../types/constants.js';

export class DefaultAdapter extends BotFrameworkAdapter {
    public readonly skills: ISkillManifest[] = [];

    public constructor(
    @inject(TYPES.BotSettings) settings: Partial<IBotSettings>,
        @inject(TYPES.LocaleTemplateManager) templateManager: LocaleTemplateManager,
        @inject(TYPES.ConversationState) conversationState: ConversationState,
        @inject(TYPES.BotFrameworkAdapterSettings) adapterSettings: Partial<BotFrameworkAdapterSettings>,
        @inject(TYPES.TelemetryInitializerMiddleware) telemetryMiddleware: TelemetryInitializerMiddleware,
        @inject(TYPES.BotTelemetryClient) telemetryClient: BotTelemetryClient
    ) {
        super(adapterSettings);

        this.onTurnError = async (context: TurnContext, error: Error): Promise<void> => {
            await context.sendActivity({
                type: ActivityTypes.Trace,
                text: error.message
            });
            await context.sendActivity({
                type: ActivityTypes.Trace,
                text: error.stack
            });
            await context.sendActivity(templateManager.generateActivityForLocale('ErrorMessage', context.activity.locale as string, {}));
            telemetryClient.trackException({ exception: error });
        };

        if (settings.blobStorage === undefined) {
            throw new Error('There is no blobStorage value in appsettings file');
        }

        const transcriptStore: TranscriptStore = new AzureBlobTranscriptStore({
            containerName: settings.blobStorage.container,
            storageAccountOrConnectionString: settings.blobStorage.connectionString
        });

        this.use(telemetryMiddleware);

        // Uncomment the following line for local development without Azure Storage
        // this.use(new TranscriptLoggerMiddleware(new MemoryTranscriptStore()));
        this.use(new TranscriptLoggerMiddleware(transcriptStore));
        this.use(new SetLocaleMiddleware(settings.defaultLocale || 'en-us'));
        this.use(new ShowTypingMiddleware());
        this.use(new FeedbackMiddleware(conversationState, telemetryClient, new FeedbackOptions()));
        this.use(new EventDebuggerMiddleware());
        this.use(new SetSpeakMiddleware());
    }
}
