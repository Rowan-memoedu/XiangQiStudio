import java.awt.EventQueue;
import java.awt.Frame;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.swing.Timer;

/** Runtime-only adapter. This class is never included in the student's project ZIP. */
public final class StudioLauncher {
    public static void main(String[] args) throws Exception {
        String entry = args.length == 0 ? "Main" : args[0];
        Class.forName(entry).getMethod("main", String[].class).invoke(null, (Object) new String[0]);
        EventQueue.invokeLater(() -> {
            boolean[] hadWindow = {false};
            Timer viewport = new Timer(200, event -> {
                boolean visible = false;
                for (Frame frame : Frame.getFrames()) visible |= frame.isDisplayable();
                if (!visible && hadWindow[0]) { ((Timer)event.getSource()).stop(); return; }
                hadWindow[0] |= visible;
                try {
                    String[] size = Files.readString(Path.of("/sockets/viewport")).trim().split(" ");
                    int width = Integer.parseInt(size[0]), height = Integer.parseInt(size[1]);
                    if (width < 640 || width > 4096 || height < 480 || height > 3072) return;
                    for (Frame frame : Frame.getFrames()) {
                        if (!frame.isShowing()) continue;
                        if (frame.getX()!=0 || frame.getY()!=0 || frame.getWidth()!=width || frame.getHeight()!=height)
                            frame.setBounds(0, 0, width, height);
                        break; // Dialogs retain their own size and stay visible over the root capture.
                    }
                } catch (Exception ignored) { /* Retry after an atomic viewport update. */ }
            });
            viewport.start();
        });
    }
}
