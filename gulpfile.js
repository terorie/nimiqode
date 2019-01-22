const gulp = require('gulp');
const concat = require('gulp-concat');

const SOURCES = [
    'index.prefix.js',
    'src/*.js',
    'index.suffix.js'
];

gulp.task('default', () => {
    return gulp.src(SOURCES)
        .pipe(concat('node.js'))
        .pipe(gulp.dest('dist'));
});
