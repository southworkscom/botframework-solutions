import { BotTelemetryClient, TurnContext } from 'botbuilder';
import { ActivityExtensions } from 'botbuilder-solutions';
import { MicrosoftAppCredentials } from 'botframework-connector';
import { Activity, ActivityTypes } from 'botframework-schema';
import { CancellationToken, IStreamingTransportClient, Request, RequestHandler } from 'microsoft-bot-protocol';
import { ISkillManifest, SkillEvents } from '../models';
import { SkillCallingRequestHandler, ActivityAction } from '../skillCallingRequestHandler';
import { ISkillTransport, TokenRequestHandler, FallbackHandler } from '../skillTransport';
import { IServiceClientCredentials } from '../auth';
import { WebSocketClient, StreamingRequest } from 'botframework-streaming-extensions';

export class SkillWebSocketTransport implements ISkillTransport {
    private readonly cToken: CancellationToken;
    private readonly telemetryClient: BotTelemetryClient;
    private streamingTransportClient!: IStreamingTransportClient;
    private handoffActivity: Partial<Activity> | undefined;

    public constructor(
        telemetryClient: BotTelemetryClient,
        streamingTransportClient?: IStreamingTransportClient
    ) {
        this.telemetryClient = telemetryClient;

        if (streamingTransportClient) {
            this.streamingTransportClient = streamingTransportClient;
        }

        this.cToken = new CancellationToken();
    }

    public async forwardToSkill(
        skillManifest: ISkillManifest,
        serviceClientCredentials: IServiceClientCredentials,
        turnContext: TurnContext,
        activity: Partial<Activity>,
        tokenRequestHandler?: TokenRequestHandler,
        fallbackHandler?: FallbackHandler
    ): Promise<Partial<Activity>> {
        if (this.streamingTransportClient === undefined) {
            const url: string = this.ensureWebSocketUrl(skillManifest.endpoint);
            const requestHandler: RequestHandler = new SkillCallingRequestHandler(
                turnContext,
                this.telemetryClient,
                tokenRequestHandler,
                this.getTokenCallback(turnContext, tokenRequestHandler),
                this.getFallbackCallback(turnContext, fallbackHandler),
                this.getHandoffActivityCallback()
            );

            // establish websocket connection
            this.streamingTransportClient = new WebSocketClient({ url, requestHandler });
        }
        // acquire AAD token
        MicrosoftAppCredentials.trustServiceUrl(skillManifest.endpoint);
        const token: string = await serviceClientCredentials.getToken();

        // put AAD token in the header
        const headers: Map<string, string> = new Map();
        headers.set('Authorization', `Bearer ${token}`);

        await this.streamingTransportClient.connectAsync(headers);
        let latency: number = 0;

        // set recipient to the skill
        if (activity !== undefined && activity.recipient !== undefined) {
            const recipientId: string = activity.recipient.id;
            activity.recipient.id = skillManifest.msaAppId;

            // Serialize the activity and POST to the Skill endpoint
            const request: StreamingRequest = StreamingRequest.create('POST', '');
            request.setBody(JSON.stringify(activity));

            // set back recipient id to make things consistent
            activity.recipient.id = recipientId;
            try {
                const begin: [number, number] = process.hrtime();
                await this.streamingTransportClient.sendAsync(request, this.cToken);
                const end: [number, number] = process.hrtime(begin);
                latency = toMilliseconds(end);
            } catch (error) {
                throw new Error('Callback failed');
            }
        }

        this.telemetryClient.trackEvent({
            name: 'SkillWebSocketTurnLatency',
            properties: {
                'SkillName': skillManifest.name,
                'SkillEndpoint': skillManifest.endpoint
            },
            metrics: { latency: latency }
        });

        if (this.handoffActivity === undefined) {
            throw new Error('handoffActivity value is Undefined');
        }

        return this.handoffActivity;
    }

    public async cancelRemoteDialogs(
        skillManifest: ISkillManifest,
        appCredentials: IServiceClientCredentials,
        turnContext: TurnContext
    ): Promise<void> {
        const cancelRemoteDialogEvent: Activity = ActivityExtensions.createReply(turnContext.activity);
        cancelRemoteDialogEvent.type = ActivityTypes.Event;
        cancelRemoteDialogEvent.name = SkillEvents.cancelAllSkillDialogsEventName;

        await this.forwardToSkill(skillManifest, appCredentials, turnContext, cancelRemoteDialogEvent);
    }

    public disconnect(): void {
        if (this.streamingTransportClient !== undefined) {
            this.streamingTransportClient.disconnect();
        }
    }

    private getHandoffActivityCallback(): ActivityAction {
        return (activity: Activity) => {
            this.handoffActivity = activity
        };
    }

    private getTokenCallback(turnContext: TurnContext, tokenRequestHandler: ActivityAction): ActivityAction {
        return (activity: Activity) => {
            tokenRequestHandler(activity);
        };
    }

    private getFallbackCallback(turnContext: TurnContext, fallbackEventHandler: ActivityAction): ActivityAction {
        return (activity: Activity) => {
            fallbackEventHandler(activity);
        };
    }

    private ensureWebSocketUrl(url: string): string {
        if (!url) {
            throw new Error('url is empty!');
        }

        // tslint:disable-next-line:no-http-string
        const httpPrefix: string = 'http://';
        const httpsPrefix: string = 'https://';
        const wsPrefix: string = 'ws://';
        const wssPrefix: string = 'wss://';

        if (url.startsWith(httpPrefix)) {
            return url.replace(httpPrefix, wsPrefix);
        }

        if (url.startsWith(httpsPrefix)) {
            return url.replace(httpsPrefix, wssPrefix);
        }

        return url;
    }
}

function toMilliseconds(hrtime: [number, number]): number {
    const nanoseconds: number = (hrtime[0] * 1e9) + hrtime[1];

    return nanoseconds / 1e6;
}
