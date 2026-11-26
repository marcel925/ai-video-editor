// sim-volume-buttons — press a booted iOS Simulator's hardware volume button N times, headless, by UDID.
// The simulated device keeps its own volume (0.6 at boot) apart from the Mac's, and only its volume buttons
// move it, so pressing volume-down mutes the device's audio while playback keeps running. Built and run by
// device-mute.mts; uses SimulatorKit's private HID client, the path Simulator.app's I/O menu takes.
//
//   sim-volume-buttons <developer dir> <udid> <down|up> <count>

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>

static const unsigned kTargetMain = 0x32;
static const unsigned kConsumerPage = 0x0c;
static const unsigned kVolumeUpUsage = 0xe9;
static const unsigned kVolumeDownUsage = 0xea;
static const unsigned kButtonDown = 1;
static const unsigned kButtonUp = 2;
static const useconds_t kPressGapMicroseconds = 60000;

typedef void *(*IndigoArbitraryFunction)(unsigned, unsigned, unsigned, unsigned);

static int fail(NSString *message) {
    fprintf(stderr, "sim-volume-buttons: %s\n", message.UTF8String);
    return 1;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 5) return fail(@"usage: sim-volume-buttons <developer dir> <udid> <down|up> <count>");
        NSString *developerDir = @(argv[1]);
        NSUUID *udid = [[NSUUID alloc] initWithUUIDString:@(argv[2])];
        BOOL isDown = strcmp(argv[3], "down") == 0;
        int count = atoi(argv[4]);
        if (!udid || count < 1) return fail(@"bad udid or count");

        if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) return fail(@(dlerror()));
        NSString *kitPath = [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
        void *kit = dlopen(kitPath.UTF8String, RTLD_NOW);
        if (!kit) return fail(@(dlerror()));
        IndigoArbitraryFunction messageFor = (IndigoArbitraryFunction)dlsym(kit, "IndigoHIDMessageForHIDArbitrary");
        Class clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
        Class contextClass = NSClassFromString(@"SimServiceContext");
        if (!messageFor || !clientClass || !contextClass) return fail(@"SimulatorKit API not found (Xcode changed it)");

        NSError *error = nil;
        id context = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(contextClass, NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), developerDir, &error);
        id deviceSet = ((id(*)(id, SEL, NSError **))objc_msgSend)(context, NSSelectorFromString(@"defaultDeviceSetWithError:"), &error);
        NSDictionary *devices = ((id(*)(id, SEL))objc_msgSend)(deviceSet, NSSelectorFromString(@"devicesByUDID"));
        id device = devices[udid];
        if (!device) return fail([NSString stringWithFormat:@"no simulator %@", udid.UUIDString]);
        id client = ((id(*)(id, SEL, id, NSError **))objc_msgSend)([clientClass alloc], NSSelectorFromString(@"initWithDevice:error:"), device, &error);
        if (!client) return fail(error.description ?: @"no HID client");

        __block BOOL didFail = NO;
        dispatch_queue_t queue = dispatch_queue_create("sim-volume-buttons", DISPATCH_QUEUE_SERIAL);
        SEL send = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
        unsigned usage = isDown ? kVolumeDownUsage : kVolumeUpUsage;
        for (int press = 0; press < count; press++) {
            for (unsigned operation = kButtonDown; operation <= kButtonUp; operation++) {
                dispatch_semaphore_t sent = dispatch_semaphore_create(0);
                void *message = messageFor(kTargetMain, kConsumerPage, usage, operation);
                ((void (*)(id, SEL, void *, BOOL, id, id))objc_msgSend)(client, send, message, YES, queue, ^(NSError *sendError) {
                    if (sendError) didFail = YES;
                    dispatch_semaphore_signal(sent);
                });
                dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
                usleep(kPressGapMicroseconds);
            }
        }
        if (didFail) return fail(@"a HID message failed to send");
        printf("pressed volume %s x%d on %s\n", isDown ? "down" : "up", count, udid.UUIDString.UTF8String);
    }
    return 0;
}
