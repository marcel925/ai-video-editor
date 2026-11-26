// sim-volume-read — print a simulated device's own output volume (0.0–1.0). Built for the iOS Simulator and run
// inside it with `xcrun simctl spawn <udid>` by device-mute.mts, which presses volume-down until this reads 0.

#import <AVFoundation/AVFoundation.h>

int main(void) {
    @autoreleasepool {
        AVAudioSession *session = [AVAudioSession sharedInstance];
        [session setCategory:AVAudioSessionCategoryAmbient error:nil];
        [session setActive:YES error:nil];
        printf("%.3f\n", session.outputVolume);
        [session setActive:NO error:nil];
    }
    return 0;
}
