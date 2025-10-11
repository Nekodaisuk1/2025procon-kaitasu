import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/middleware';
import { adminDb } from '@/lib/firebaseAdmin';

export const GET = withAuth(async (_req: NextRequest, uid: string) => {
	const doc = await adminDb.collection('users').doc(uid).get();
	const data = doc.data() || {};

	const response = {
		name: data.userName || '',
		monthlyBudget: data.monthlyBudget ?? 50000,
		resetDay: data.resetDay ?? 1,
		surveyCompleted: data.surveyCompleted ?? false,
	};

	return NextResponse.json(response);
});

// POST /api/user-information - ユーザー情報を初期設定（健康設定）
export const POST = withAuth(async (req: NextRequest, uid: string) => {
    // リクエストボディを取得
    const body = await req.json();
    const { disease, increaseNutrients, reduceNutrients } = body;

    // バリデーション
    const validDiseases = ['Hypertension', 'KidneyDisease', 'Sarcopenia', 'Diabetes', 'Osteoporosis'];
    const validIncreaseNutrients = ['Protein', 'VitaminD', 'Ca', 'Fiber', 'Potassium'];
    const validReduceNutrients = ['Salt', 'Fat', 'Sugar', 'Vitamin', 'Mineral'];

    if (disease && !Array.isArray(disease)) {
      return NextResponse.json({ error: 'diseaseは配列である必要があります' }, { status: 400 });
    }
    if (increaseNutrients && !Array.isArray(increaseNutrients)) {
      return NextResponse.json({ error: 'increaseNutrientsは配列である必要があります' }, { status: 400 });
    }
    if (reduceNutrients && !Array.isArray(reduceNutrients)) {
      return NextResponse.json({ error: 'reduceNutrientsは配列である必要があります' }, { status: 400 });
    }

    // 値の検証
    if (disease && disease.some(d => !validDiseases.includes(d))) {
      return NextResponse.json({ error: '無効なdiseaseの値が含まれています' }, { status: 400 });
    }
    if (increaseNutrients && increaseNutrients.some(n => !validIncreaseNutrients.includes(n))) {
      return NextResponse.json({ error: '無効なincreaseNutrientsの値が含まれています' }, { status: 400 });
    }
    if (reduceNutrients && reduceNutrients.some(n => !validReduceNutrients.includes(n))) {
      return NextResponse.json({ error: '無効なreduceNutrientsの値が含まれています' }, { status: 400 });
    }

    // アンケート回答を栄養フラグに変換
    const diseaseUp: Record<string, string[]> = {
      Hypertension: ["K","MG","CA","FIB","VITC","TOCPHA"],
      KidneyDisease: ["PROT","FIB","VITD","CA"],
      Sarcopenia: ["PROT","VITD","CA","MG","VITB6A","VITB12","ENERC_KCAL"],
      Diabetes: ["FIB","MG","THIA","VITB6A","NIA","VITC","TOCPHA"],
      Osteoporosis: ["CA","VITD","VITK","MG","PROT","ZN","CU"],
    };
    const diseaseDown: Record<string, string[]> = {
      Hypertension: ["NA","NACL_EQ","FATNLEA","CHOLE"],
      KidneyDisease: ["NA","NACL_EQ","P","PROT"],
      Sarcopenia: ["NA","FATNLEA"],
      Diabetes: ["CHOAVLM","CHOCDF","FATNLEA","NA","NACL_EQ","CHOLE"],
      Osteoporosis: ["NA","NACL_EQ","P","VITA_RAE"],
    };
    const increaseByBucket: Record<string, string[]> = {
      Protein: ["PROT"],
      VitaminD: ["VITD"],
      Ca: ["CA"],
      Fiber: ["FIB"],
      Potassium: ["K"],
    };
    const reduceByBucket: Record<string, string[]> = {
      Salt: ["NA","NACL_EQ"],
      Fat: ["FAT","FATNLEA","CHOLE"],
      Sugar: ["CHOCDF","CHOAVLM"],
      Vitamin: ["VITA_RAE","VITD","TOCPHA","VITK"],
      Mineral: ["NA","P"],
    };

    // 栄養フラグを計算
    const score: Record<string, number> = {};
    
    // 病気ルール
    for (const d of (disease || [])) {
      for (const k of (diseaseUp[d] || [])) score[k] = (score[k] || 0) + 1;
      for (const k of (diseaseDown[d] || [])) score[k] = (score[k] || 0) - 1;
    }
    // ユーザー指定
    for (const b of (increaseNutrients || [])) {
      for (const k of (increaseByBucket[b] || [])) score[k] = (score[k] || 0) + 1;
    }
    for (const b of (reduceNutrients || [])) {
      for (const k of (reduceByBucket[b] || [])) score[k] = (score[k] || 0) - 1;
    }

    // 0を除外して、-1 or 1 に正規化
    const nutrition: Record<string, number> = {};
    for (const [k, v] of Object.entries(score)) {
      if (v === 0) continue;
      nutrition[k] = v > 0 ? 1 : -1;
    }

    console.log('[user-information] Calculated nutrition:', nutrition);

    // Firestoreのユーザードキュメントを更新
    await adminDb.collection('users').doc(uid).set({
      disease: disease || [],
      increaseNutrients: increaseNutrients || [],
      reduceNutrients: reduceNutrients || [],
      nutrition: nutrition,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    return NextResponse.json({ msg: 'success' });
});

// PATCH /api/user-information - ユーザー情報を更新
export async function PATCH(request: NextRequest) {
  try {
    // Authorizationヘッダーからトークンを取得
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: '認証トークンが必要です' }, { status: 401 });
    }

    const token = authHeader.split('Bearer ')[1];
    
    // トークンを検証してuidを取得
    let uid: string;
    try {
      const decodedToken = await adminAuth.verifyIdToken(token);
      uid = decodedToken.uid;
    } catch (error) {
      console.error('トークン検証エラー:', error);
      return NextResponse.json({ error: '無効な認証トークンです' }, { status: 401 });
    }

    // リクエストボディを取得
    const body = await request.json();
    const { name, monthlyBudget, resetDay, surveyCompleted } = body;

    // 更新するフィールドを準備
    const updateData: any = {};
    
    if (name !== undefined) {
      updateData.userName = name;
    }
    if (monthlyBudget !== undefined) {
      if (typeof monthlyBudget !== 'number' || monthlyBudget < 0) {
        return NextResponse.json({ error: 'monthlyBudgetは0以上の数値である必要があります' }, { status: 400 });
      }
      updateData.monthlyBudget = monthlyBudget;
    }
    if (resetDay !== undefined) {
      if (typeof resetDay !== 'number' || resetDay < 1 || resetDay > 31) {
        return NextResponse.json({ error: 'resetDayは1-31の数値である必要があります' }, { status: 400 });
      }
      updateData.resetDay = resetDay;
    }
    if (surveyCompleted !== undefined) {
      if (typeof surveyCompleted !== 'boolean') {
        return NextResponse.json({ error: 'surveyCompletedはbooleanである必要があります' }, { status: 400 });
      }
      updateData.surveyCompleted = surveyCompleted;
    }

    // 少なくとも1つのフィールドが更新される必要がある
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: '更新するフィールドが指定されていません' }, { status: 400 });
    }

    // タイムスタンプを追加
    updateData.updatedAt = new Date().toISOString();

    // Firestoreのユーザー情報を更新
    await adminDb.collection('users').doc(uid).set(updateData, { merge: true });

    return NextResponse.json({ msg: 'success' });
  } catch (error) {
    console.error('ユーザー情報更新エラー:', error);
    return NextResponse.json({ error: 'サーバーエラーが発生しました' }, { status: 500 });
  }
}
