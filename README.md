LIFTS — Workout Tracker 🏋️

LIFTS is a web-based workout tracking application that helps users log their workouts, track exercise progress, and monitor their performance over time.

🚀 Features

* 📝 Log workouts and sets
* 💪 Track weights and repetitions
* 📊 View workout history and progress
* 🧍 Post-workout front/back body map with green muscle highlights
* 🏆 Workout completion stats and new personal records
* ⏱️ Built-in rest timer
* 🔥 Track workout streaks
* 🔐 Firebase authentication
* ☁️ Cloud data synchronization with Firebase
* 📱 Responsive and easy-to-use interface

🛠️ Technologies

* HTML
* CSS
* JavaScript
* Firebase Authentication
* Firebase Firestore
* Chart.js


🧍 Workout completion body map

After **Finish Workout → Finish**, a completion card shows duration, exercises, sets, new PRs, and **What you just trained**. The front/back map uses green highlights; brighter muscles have more sets in that workout. Expand a completed workout in History to see its map again.

* Only logged sets from that workout count—not planned exercises or the manual totals in Progress.
* Muscle involvement is estimated from exercise names. Custom exercises can use a muscle-specific category, such as Chest or Hamstrings; unmatched exercises are listed instead of guessed.
* Compound sets can count toward multiple muscles. Highlights represent estimated set involvement, not fatigue or recovery.
* New workout records save muscle assignments so later exercise/category renames do not change those maps. Older records are estimated from their saved exercise names.
* PRs compare the workout's best set against its pre-workout record, with kg/lb normalization and reps as the tie-breaker. First records establish a benchmark. Baselines survive active-workout saves/restores; older resumed workouts without a baseline do not generate speculative PR claims.

🧪 Tests

Run the dependency-free regression suite with Node.js 18 or later:

```sh
node --test tests/body-map.test.cjs
```

For a local browser preview:

```sh
python3 -m http.server 8080 --bind 0.0.0.0
```

🎯 Purpose

I built LIFTS to create a simple and practical way to record gym workouts and monitor strength progression over time.

👨‍💻 Author

Mostafa Farid

GitHub: mostafafarid377-art