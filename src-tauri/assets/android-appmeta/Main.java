package com.taskdock.appmeta;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Looper;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.util.List;

public final class Main {
    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Method systemMain = activityThread.getDeclaredMethod("systemMain");
        systemMain.setAccessible(true);
        Object thread = systemMain.invoke(null);
        Method getSystemContext = activityThread.getDeclaredMethod("getSystemContext");
        getSystemContext.setAccessible(true);
        Context context = (Context) getSystemContext.invoke(thread);
        PackageManager pm = context.getPackageManager();
        List<ApplicationInfo> apps = pm.getInstalledApplications(0);
        File outDir = new File("/data/local/tmp/taskdock-appmeta");
        outDir.mkdirs();
        for (ApplicationInfo ai : apps) {
            CharSequence label = pm.getApplicationLabel(ai);
            boolean system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            boolean launchable = pm.getLaunchIntentForPackage(ai.packageName) != null;
            String iconPath = "";
            try {
                Resources res = pm.getResourcesForApplication(ai);
                Drawable drawable = res.getDrawable(ai.icon, null);
                Bitmap bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(bitmap);
                drawable.setBounds(0, 0, 96, 96);
                drawable.draw(canvas);
                File file = new File(outDir, ai.packageName.replaceAll("[^A-Za-z0-9._-]", "_") + ".png");
                try (FileOutputStream out = new FileOutputStream(file)) {
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
                }
                iconPath = file.getAbsolutePath();
            } catch (Throwable ignored) {
                iconPath = "";
            }
            String safeLabel = String.valueOf(label).replace("\t", " ").replace("\n", " ");
            System.out.println(ai.packageName + "\t" + safeLabel + "\t" + (system ? "1" : "0") + "\t" + (launchable ? "1" : "0") + "\t" + iconPath);
        }
    }
}
