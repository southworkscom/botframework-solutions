import 'reflect-metadata';
import { decorate, injectable, Container } from 'inversify';
import { TYPES } from './types/constants';
import { IBotSettings } from './services/botSettings';
import * as appsettings from './appsettings.json';
import * as cognitiveModelsRaw from './cognitivemodels.json';
import { ICognitiveModelConfiguration, LocaleTemplateEngineManager, SkillConversationIdFactory, SwitchSkillDialog, IEnhancedBotFrameworkSkill, SkillsConfiguration } from 'bot-solutions';
import { SimpleCredentialProvider, AuthenticationConfiguration, Claim } from 'botframework-connector';
import { BotTelemetryClient, NullTelemetryClient, TelemetryLoggerMiddleware, UserState, ConversationState, BotFrameworkAdapterSettings, BotFrameworkAdapter, SkillConversationIdFactoryBase, SkillHttpClient, TeamsActivityHandler, ActivityHandler, ActivityHandlerBase } from 'botbuilder';
import { ApplicationInsightsTelemetryClient, TelemetryInitializerMiddleware } from 'botbuilder-applicationinsights';
import { BotServices } from './services/botServices';
import { CosmosDbPartitionedStorage } from 'botbuilder-azure';
import * as path from 'path';
import { DefaultAdapter } from './adapters/defaultAdapter';
import { MainDialog } from './dialogs/mainDialog';
import { OnboardingDialog } from './dialogs/onboardingDialog';
import { SkillDialog, SkillDialogOptions, ComponentDialog, DialogContainer, Dialog } from 'botbuilder-dialogs';
import { AllowedCallersClaimsValidator } from './authentication/allowedCallersClaimsValidator';
import { DefaultActivityHandler } from './bots/defaultActivityHandler';

const container = new Container();

const cognitiveModels: Map<string, ICognitiveModelConfiguration> = new Map();
const cognitiveModelDictionary: { [key: string]: Object } = cognitiveModelsRaw.cognitiveModels;
const cognitiveModelMap: Map<string, Object> = new Map(Object.entries(cognitiveModelDictionary));
cognitiveModelMap.forEach((value: Object, key: string): void => {
    cognitiveModels.set(key, value as ICognitiveModelConfiguration);
});
const botSettings: Partial<IBotSettings> = {
    appInsights: appsettings.appInsights,
    blobStorage: appsettings.blobStorage,
    cognitiveModels: cognitiveModels,
    cosmosDb: appsettings.cosmosDb,
    defaultLocale: cognitiveModelsRaw.defaultLocale,
    microsoftAppId: appsettings.microsoftAppId,
    microsoftAppPassword: appsettings.microsoftAppPassword
};

// Load settings
container.bind<Partial<IBotSettings>>(TYPES.BotSettings).toConstantValue(botSettings);

// Configure configuration provider
decorate(injectable(), SimpleCredentialProvider);
container.bind<SimpleCredentialProvider>(TYPES.SimpleCredentialProvider).toConstantValue(new SimpleCredentialProvider(appsettings.microsoftAppId, appsettings.microsoftAppPassword));

// Configure telemetry
container.bind<BotTelemetryClient>(TYPES.BotTelemetryClient).toConstantValue(getTelemetryClient(container.get<IBotSettings>(TYPES.BotSettings)));
decorate(injectable(), TelemetryLoggerMiddleware);
container.bind<TelemetryLoggerMiddleware>(TYPES.TelemetryLoggerMiddleware).toConstantValue(new TelemetryLoggerMiddleware(container.get<BotTelemetryClient>(TYPES.BotTelemetryClient)));
decorate(injectable(), TelemetryInitializerMiddleware);
container.bind<TelemetryInitializerMiddleware>(TYPES.TelemetryInitializerMiddleware).toConstantValue(new TelemetryInitializerMiddleware(container.get<TelemetryLoggerMiddleware>(TYPES.TelemetryLoggerMiddleware)));

// Configure bot services
decorate(injectable(), BotServices);
container.bind<BotServices>(TYPES.BotServices).to(BotServices).inSingletonScope();

// Configure storage
// Uncomment the following line for local development without Cosmos Db
// decorate(injectable(), MemoryStorage);
// container.bind<Partial<MemoryStorage>>(TYPES.MemoryStorage).toConstantValue(new MemoryStorage());
decorate(injectable(), CosmosDbPartitionedStorage);
container.bind<CosmosDbPartitionedStorage>(TYPES.CosmosDbPartitionedStorage).toConstantValue(new CosmosDbPartitionedStorage(container.get<IBotSettings>(TYPES.BotSettings).cosmosDb));
decorate(injectable(), UserState);
container.bind<UserState>(TYPES.UserState).toConstantValue(new UserState(container.get<CosmosDbPartitionedStorage>(TYPES.CosmosDbPartitionedStorage)));
decorate(injectable(), ConversationState);
container.bind<ConversationState>(TYPES.ConversationState).toConstantValue(new ConversationState(container.get<CosmosDbPartitionedStorage>(TYPES.CosmosDbPartitionedStorage)));

// Configure localized responses
const localizedTemplates: Map<string, string[]> = new Map<string, string[]>();
const templateFiles: string[] = ['MainResponses', 'OnboardingResponses'];
const supportedLocales: string[] = ['en-us', 'de-de', 'es-es', 'fr-fr', 'it-it', 'zh-cn'];

supportedLocales.forEach((locale: string) => {
    const localeTemplateFiles: string[] = [];
    templateFiles.forEach(template => {
        // LG template for en-us does not include locale in file extension.
        if (locale === 'en-us') {
            localeTemplateFiles.push(path.join(__dirname, 'responses', `${ template }.lg`));
        }
        else {
            localeTemplateFiles.push(path.join(__dirname, 'responses', `${ template }.${ locale }.lg`));
        }
    });

    localizedTemplates.set(locale, localeTemplateFiles);
});

decorate(injectable(), LocaleTemplateEngineManager);
container.bind<LocaleTemplateEngineManager>(TYPES.LocaleTemplateEngineManager).toConstantValue(new LocaleTemplateEngineManager(localizedTemplates, container.get<IBotSettings>(TYPES.BotSettings).defaultLocale || 'en-us'));

// Register the Bot Framework Adapter with error handling enabled.
// Note: some classes use the base BotAdapter so we add an extra registration that pulls the same instance.
const adapterSettings: Partial<BotFrameworkAdapterSettings> = {
    appId: botSettings.microsoftAppId,
    appPassword: botSettings.microsoftAppPassword
};
container.bind<Partial<BotFrameworkAdapterSettings>>(TYPES.BotFrameworkAdapterSettings).toConstantValue(adapterSettings);

decorate(injectable(), DefaultAdapter);
decorate(injectable(), BotFrameworkAdapter);
container.bind<DefaultAdapter>(TYPES.DefaultAdapter).to(DefaultAdapter).inSingletonScope();

// Register the skills conversation ID factory, the client and the request handler
decorate(injectable(), SkillConversationIdFactory);
container.bind<SkillConversationIdFactoryBase>(TYPES.SkillConversationIdFactory).toConstantValue(new SkillConversationIdFactory(container.get<CosmosDbPartitionedStorage>(TYPES.CosmosDbPartitionedStorage)));

decorate(injectable(), SkillHttpClient);
container.bind<SkillHttpClient>(TYPES.SkillHttpClient).toConstantValue(new SkillHttpClient(container.get<SimpleCredentialProvider>(TYPES.SimpleCredentialProvider), container.get<SkillConversationIdFactoryBase>(TYPES.SkillConversationIdFactory)));

// Register dialogs
decorate(injectable(), Dialog);
decorate(injectable(), DialogContainer);
decorate(injectable(), ComponentDialog);
decorate(injectable(), MainDialog);
container.bind<MainDialog>(TYPES.MainDialog).to(MainDialog).inTransientScope();

decorate(injectable(), SwitchSkillDialog);
//VALIDATE.. BOT-SOLUTIONS SHOULD HAVE INVERSIFY ALSO??
container.bind<SwitchSkillDialog>(TYPES.SwitchSkillDialog).toConstantValue(new SwitchSkillDialog(container.get<ConversationState>(TYPES.ConversationState)));

decorate(injectable(), OnboardingDialog);
container.bind<OnboardingDialog>(TYPES.OnboardingDialog).to(OnboardingDialog).inTransientScope();

// Register the SkillDialogs (remote skills).
const skills: IEnhancedBotFrameworkSkill[] = appsettings.botFrameworkSkills;
if (skills !== undefined && skills.length > 0) {
    const hostEndpoint: string = appsettings.skillHostEndpoint;
    if (hostEndpoint === undefined || hostEndpoint.trim().length === 0) {
        throw new Error('\'skillHostEndpoint\' is not in the configuration');
    } else {
        decorate(injectable(), SkillsConfiguration);
        container.bind<SkillsConfiguration>(TYPES.SkillsConfiguration).toConstantValue(new SkillsConfiguration(skills, hostEndpoint));
        const allowedCallersClaimsValidator: AllowedCallersClaimsValidator = new AllowedCallersClaimsValidator(container.get<SkillsConfiguration>(TYPES.SkillsConfiguration));

        // Register AuthConfiguration to enable custom claim validation.
        decorate(injectable(), AuthenticationConfiguration);
        container.bind<AuthenticationConfiguration>(TYPES.AuthenticationConfiguration).toConstantValue(new AuthenticationConfiguration(
            undefined,
            (claims: Claim[]) => allowedCallersClaimsValidator.validateClaims(claims)
        ));

        const skillDialogs: SkillDialog[] = skills.map((skill: IEnhancedBotFrameworkSkill): SkillDialog => {
            const skillDialogOptions: SkillDialogOptions = {
                botId: appsettings.microsoftAppId,
                conversationIdFactory: container.get<SkillConversationIdFactoryBase>(TYPES.SkillConversationIdFactory),
                skillClient: container.get<SkillHttpClient>(TYPES.SkillHttpClient),
                skillHostEndpoint: hostEndpoint,
                skill: skill,
                conversationState: container.get<ConversationState>(TYPES.ConversationState)
            };
            return new SkillDialog(skillDialogOptions, skill.id);
        });

        decorate(injectable(), SkillDialog);
        container.bind<SkillDialog[]>(TYPES.SkillDialogs).toConstantValue(skillDialogs);
    }
}

// Configure bot
decorate(injectable(), ActivityHandlerBase);
decorate(injectable(), ActivityHandler);
decorate(injectable(), TeamsActivityHandler);
decorate(injectable(), DefaultActivityHandler);
container.bind<DefaultActivityHandler<MainDialog>>(TYPES.DefaultActivityHandler).to(DefaultActivityHandler).inTransientScope();

export default container;

function getTelemetryClient(settings: Partial<IBotSettings>): BotTelemetryClient {
    if (settings !== undefined && settings.appInsights !== undefined && settings.appInsights.instrumentationKey !== undefined) {
        const instrumentationKey: string = settings.appInsights.instrumentationKey;

        return new ApplicationInsightsTelemetryClient(instrumentationKey);
    }

    return new NullTelemetryClient();
}
