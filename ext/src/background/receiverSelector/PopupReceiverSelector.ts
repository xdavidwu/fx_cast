"use strict";

import ReceiverSelector, {
        ReceiverSelectorEvents
      , ReceiverSelectorMediaType } from "./ReceiverSelector";

import logger from "../../lib/logger";
import messaging, { Port, Message } from "../../lib/messaging";
import options from "../../lib/options";

import { TypedEventTarget } from "../../lib/TypedEventTarget";
import { getWindowCenteredProps, WindowCenteredProps } from "../../lib/utils";
import { Receiver } from "../../types";


const POPUP_URL = browser.runtime.getURL("ui/popup/index.html");

export default class PopupReceiverSelector
        extends TypedEventTarget<ReceiverSelectorEvents>
        implements ReceiverSelector {

    private windowId?: number;

    private messagePort?: Port;
    private messagePortDisconnected?: boolean;

    private receivers?: Receiver[];
    private defaultMediaType?: ReceiverSelectorMediaType;
    private availableMediaTypes?: ReceiverSelectorMediaType;

    private wasReceiverSelected: boolean = false;

    private _isOpen: boolean = false;
    private requestedAppId?: string;


    constructor () {
        super();

        // Bind methods to pass to addListener
        this.onConnect = this.onConnect.bind(this);
        this.onPopupMessage = this.onPopupMessage.bind(this);
        this.onWindowsRemoved = this.onWindowsRemoved.bind(this);
        this.onWindowsFocusChanged = this.onWindowsFocusChanged.bind(this);

        browser.windows.onRemoved.addListener(this.onWindowsRemoved);

        /**
         * Handle incoming message channel connection from popup
         * window script.
         */
        messaging.onConnect.addListener(this.onConnect);
    }

    get isOpen () {
        return this._isOpen;
    }

    public async open (
            receivers: Receiver[]
          , defaultMediaType: ReceiverSelectorMediaType
          , availableMediaTypes: ReceiverSelectorMediaType
          , requestedAppId: string): Promise<void> {

        this.requestedAppId = requestedAppId;

        // If popup already exists, close it
        if (this.windowId) {
            await browser.windows.remove(this.windowId);
        }

        this.receivers = receivers;
        this.defaultMediaType = defaultMediaType;
        this.availableMediaTypes = availableMediaTypes;


        let centeredProps: WindowCenteredProps = {
            left: 100
          , top: 100
          , width: 350
          , height: 200
        };

        try {
            // Calculate centered size/position based on current window
            centeredProps = getWindowCenteredProps(
                    await browser.windows.getCurrent()
                  , centeredProps.width, centeredProps.height);
        } catch {
            // Shouldn't ever hit this, but defaults are provided in case
        }

        const popup = await browser.windows.create({
            url: POPUP_URL
          , type: "detached_panel"
          , ...centeredProps
        });

        if (popup?.id === undefined) {
            throw logger.error("Failed to create receiver selector popup.");
        }

        this._isOpen = true;
        this.windowId = popup.id;

        // Size/position not set correctly on creation (bug?)
        await browser.windows.update(this.windowId, {
            ...centeredProps
        });


        const closeIfFocusLost = await options.get(
                "receiverSelectorCloseIfFocusLost");

        if (closeIfFocusLost) {
            // Add focus listener
            browser.windows.onFocusChanged.addListener(
                    this.onWindowsFocusChanged);
        }
    }

    public async close (): Promise<void> {
        if (this.windowId) {
            await browser.windows.remove(this.windowId);
        }

        this._isOpen = false;
        this.requestedAppId = undefined;

        if (this.messagePort && !this.messagePortDisconnected) {
            this.messagePort.disconnect();
        }
    }

    private onConnect (port: Port) {
        browser.history.deleteUrl({ url: POPUP_URL });

        if (port.name !== "popup") {
            return;
        }

        if (this.messagePort) {
            this.messagePort.disconnect();
        }

        this.messagePort = port;
        this.messagePort.onMessage.addListener(this.onPopupMessage);
        this.messagePort.onDisconnect.addListener(() => {
            this.messagePortDisconnected = true;
        });

        if (!this.requestedAppId
         || !this.receivers
         || !this.defaultMediaType
         || !this.availableMediaTypes) {
            throw logger.error("Popup receiver data not found.");
        }

        this.messagePort.postMessage({
            subject: "popup:/sendRequestedAppId"
          , data: { requestedAppId: this.requestedAppId }
        });

        this.messagePort.postMessage({
            subject: "popup:/populateReceiverList"
          , data: {
                receivers: this.receivers
              , defaultMediaType: this.defaultMediaType
              , availableMediaTypes: this.availableMediaTypes
            }
        });

        messaging.onConnect.removeListener(this.onConnect);
    }

    /**
     * Handles popup messages.
     */
    private onPopupMessage (message: Message) {
        switch (message.subject) {
            case "receiverSelector:/selected": {
                this.wasReceiverSelected = true;
                this.dispatchEvent(new CustomEvent("selected", {
                    detail: message.data
                }));

                break;
            }

            case "receiverSelector:/stop": {
                this.dispatchEvent(new CustomEvent("stop", {
                    detail: message.data
                }));

                break;
            }
        }
    }

    /**
     * Handles cancellation state where the popup window is closed
     * before a receiver is selected.
     */
    private onWindowsRemoved (windowId: number) {
        // Only care about popup window
        if (windowId !== this.windowId) {
            return;
        }

        browser.windows.onRemoved.removeListener(this.onWindowsRemoved);
        browser.windows.onFocusChanged.removeListener(
                this.onWindowsFocusChanged);

        if (!this.wasReceiverSelected) {
            this.dispatchEvent(new CustomEvent("cancelled"));
        }

        // Cleanup
        this.windowId = undefined;
        this.messagePort = undefined;
        this.receivers = undefined;
        this.defaultMediaType = undefined;
        this.availableMediaTypes = undefined;
        this.wasReceiverSelected = false;
    }

    /**
     * Closes popup window if another browser window is brought
     * into focus. Doesn't apply if no window is focused
     * `WINDOW_ID_NONE` or if the popup window is re-focused.
     */
    private onWindowsFocusChanged (windowId: number) {
        if (windowId !== browser.windows.WINDOW_ID_NONE
                && windowId !== this.windowId) {

            // Only run once
            browser.windows.onFocusChanged.removeListener(
                    this.onWindowsFocusChanged);

            if (this.windowId) {
                browser.windows.remove(this.windowId);
            }
        }
    }
}
