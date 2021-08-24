// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { SwapMath } from "@uniswap/v3-core/contracts/libraries/SwapMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { LiquidityMath } from "@uniswap/v3-core/contracts/libraries/LiquidityMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { FeeMath } from "./lib/FeeMath.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { Validation } from "./base/Validation.sol";
import { Tick } from "./lib/Tick.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { IVault } from "./interface/IVault.sol";
import { ArbBlockContext } from "./arbitrum/ArbBlockContext.sol";
import { Exchange } from "./Exchange.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { Funding } from "./lib/Funding.sol";
import { PerpFixedPoint96 } from "./lib/PerpFixedPoint96.sol";

contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    ISettlement,
    ReentrancyGuard,
    Validation,
    Ownable
{
    using SafeMath for uint256;
    using SafeMath for uint160;
    using PerpSafeCast for uint256;
    using PerpSafeCast for uint128;
    using SignedSafeMath for int256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;
    using Tick for mapping(int24 => Tick.GrowthInfo);
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;

    //
    // events
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event Minted(address indexed trader, address indexed token, uint256 amount);
    event Burned(address indexed trader, address indexed token, uint256 amount);
    event LiquidityChanged(
        address indexed maker,
        address indexed baseToken,
        address indexed quoteToken,
        int24 lowerTick,
        int24 upperTick,
        // amount of base token added to the liquidity (excl. fee) (+: add liquidity, -: remove liquidity)
        int256 base,
        // amount of quote token added to the liquidity (excl. fee) (+: add liquidity, -: remove liquidity)
        int256 quote,
        int128 liquidity, // amount of liquidity unit added (+: add liquidity, -: remove liquidity)
        uint256 quoteFee // amount of quote token the maker received as fee
    );
    event FundingSettled(
        address indexed trader,
        address indexed baseToken,
        int256 amount // +: trader pays, -: trader receives
    );
    event GlobalFundingGrowthUpdated(
        address indexed baseToken,
        int256 twPremiumGrowthX192,
        int256 twPremiumDivBySqrtPriceX96
    );
    event Swapped(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 exchangedPositionNotional,
        uint256 fee
    );

    event LiquidationPenaltyRatioChanged(uint256 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint256 partialCloseRatio);

    event PositionLiquidated(
        address indexed trader,
        address indexed baseToken,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator
    );

    //
    // Struct
    //

    struct Account {
        // realized pnl but haven't settle to collateral, vToken decimals
        int256 owedRealizedPnl;
        address[] tokens; // all tokens (base only) this account is in debt of
        // key: token address, e.g. vETH...
        mapping(address => TokenInfo) tokenInfoMap; // balance & debt info of each token
        // key: token address, value: the last twPremiumGrowthGlobalX96
        mapping(address => int256) lastTwPremiumGrowthGlobalX96Map;
    }

    struct TokenInfo {
        uint256 available; // amount available in CH
        uint256 debt;
    }

    /// @param feeGrowthInsideClearingHouseLastX128 there is only quote fee in ClearingHouse
    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideClearingHouseLastX128;
        int256 lastTwPremiumGrowthInsideX96;
        int256 lastTwPremiumGrowthBelowX96;
        int256 lastTwPremiumDivBySqrtPriceGrowthInsideX96;
    }

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
        uint256 minBase;
        uint256 minQuote;
        uint256 deadline;
    }

    struct RemoveLiquidityFromOrderParams {
        address maker;
        address baseToken;
        address pool;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideQuoteX128;
        uint256 liquidity;
    }

    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }

    struct SwapParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct InternalSwapParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool mintForTrader;
    }

    struct ReplaySwapParams {
        SwapState state;
        address baseToken;
        bool isBaseToQuote;
        bool shouldUpdateState;
        uint160 sqrtPriceLimitX96;
        uint24 clearingHouseFeeRatio;
        uint24 uniswapFeeRatio;
        Funding.Growth globalFundingGrowth;
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        uint256 exchangedPositionSize;
        uint256 exchangedPositionNotional;
    }

    struct SwapStep {
        uint160 initialSqrtPriceX96;
        int24 nextTick;
        bool isNextTickInitialized;
        uint160 nextSqrtPriceX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
    }

    struct SwapState {
        int24 tick;
        uint160 sqrtPriceX96;
        int256 amountSpecifiedRemaining;
        uint256 feeGrowthGlobalX128;
        uint128 liquidity;
    }

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
    }

    struct InternalSwapState {
        address pool;
        uint24 clearingHouseFeeRatio;
        uint24 uniswapFeeRatio;
        uint256 fee;
        uint256 insuranceFundFee;
    }

    // 10 wei
    uint256 private constant _DUST = 10;

    //
    // state variables
    //
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;
    address public vault;
    address public insuranceFund;
    address public exchange;

    uint256 public imRatio = 0.1 ether; // initial-margin ratio, 10%
    uint256 public mmRatio = 0.0625 ether; // minimum-margin ratio, 6.25%

    uint8 private immutable _settlementTokenDecimals;

    uint32 public twapInterval = 15 minutes;

    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: trader
    mapping(address => Account) private _accountMap;

    // key: accountBaseTokenKey, which is a hash of account and baseToken
    // value: fraction of open notional that can unify the openNotional for both maker and taker
    mapping(bytes32 => int256) private _openNotionalFractionMap;

    // key: base token
    mapping(address => uint256) private _firstTradedTimestampMap;
    mapping(address => uint256) private _lastSettledTimestampMap;
    mapping(address => Funding.Growth) private _globalFundingGrowthX96Map;

    uint256 public liquidationPenaltyRatio = 0.025 ether; // initial penalty ratio, 2.5%
    uint256 public partialCloseRatio = 0.25 ether; // partial close ratio, 25%
    uint8 public maxMarketsPerAccount;

    constructor(
        address vaultArg,
        address insuranceFundArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        uint8 maxMarketsPerAccountArg
    ) {
        // vault is 0
        require(vaultArg != address(0), "CH_VI0");
        // InsuranceFund is 0
        require(insuranceFundArg != address(0), "CH_IFI0");

        // quoteToken is 0
        require(quoteTokenArg != address(0), "CH_QI0");
        // CH_QDN18: quoteToken decimals is not 18
        require(IERC20Metadata(quoteTokenArg).decimals() == 18, "CH_QDN18");

        // uniV3Factory is 0
        require(uniV3FactoryArg != address(0), "CH_U10");

        vault = vaultArg;
        insuranceFund = insuranceFundArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
        maxMarketsPerAccount = maxMarketsPerAccountArg;

        _settlementTokenDecimals = IVault(vault).decimals();
    }

    //
    // MODIFIER
    //
    modifier checkRatio(uint256 ratio) {
        // CH_RL1: ratio overflow
        require(ratio <= 1 ether, "CH_RO");
        _;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        address pool = Exchange(exchange).addPool(baseToken, feeRatio);
        _poolMap[baseToken] = pool;

        // TODO move to ex and fix tests
        // CH_BDN18: baseToken decimals is not 18
        require(IERC20Metadata(baseToken).decimals() == 18, "CH_BDN18");
        // to ensure the base is always token0 and quote is always token1
        // CH_IB: invalid baseToken
        require(baseToken < quoteToken, "CH_IB");
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(pool != _poolMap[baseToken], "CH_EP");
        // CH_PNI: pool not (yet) initialized
        require(Exchange(exchange).getSqrtMarkPriceX96(baseToken) != 0, "CH_PNI");

        emit PoolAdded(baseToken, feeRatio, pool);
    }

    function setExchange(address exchangeArg) external onlyOwner {
        exchange = exchangeArg;
    }

    function setMaxTickCrossedWithinBlock(address baseToken, uint256 maxTickCrossedWithinBlock) external onlyOwner {
        _requireHasBaseToken(baseToken);
        Exchange(exchange).setMaxTickCrossedWithinBlock(baseToken, maxTickCrossedWithinBlock);
    }

    function mint(address token, uint256 amount) external nonReentrant() {
        if (token != quoteToken) {
            _requireHasBaseToken(token);
            _registerBaseToken(_msgSender(), token);
        }
        // always check margin ratio
        _mint(_msgSender(), token, amount, true);
    }

    /**
     * @param amount the amount of debt to burn
     */
    function burn(address token, uint256 amount) external nonReentrant() {
        if (token != quoteToken) {
            _requireHasBaseToken(token);
        }
        _burn(_msgSender(), token, amount);
    }

    function swap(SwapParams memory params) external nonReentrant() returns (SwapResponse memory) {
        _requireHasBaseToken(params.baseToken);
        _registerBaseToken(_msgSender(), params.baseToken);

        return
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
                    trader: _msgSender(),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    mintForTrader: false
                })
            );
    }

    function addLiquidity(AddLiquidityParams calldata params) external nonReentrant() checkDeadline(params.deadline) {
        _requireHasBaseToken(params.baseToken);

        address trader = _msgSender();
        // register token if it's the first time
        _registerBaseToken(trader, params.baseToken);

        Funding.Growth memory updatedGlobalFundingGrowth =
            _settleFundingAndUpdateFundingGrowth(trader, params.baseToken);

        // update internal states
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        // CH_NEB: not enough available base amount
        require(baseTokenInfo.available >= params.base, "CH_NEB");
        // CH_NEB: not enough available quote amount
        require(quoteTokenInfo.available >= params.quote, "CH_NEQ");

        Exchange.AddLiquidityResponse memory response =
            Exchange(exchange).addLiquidity(
                Exchange.AddLiquidityParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    base: params.base,
                    quote: params.quote,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    minBase: params.minBase,
                    minQuote: params.minQuote,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth
                })
            );

        // update token info
        // TODO should burn base fee received instead of adding it to available amount
        baseTokenInfo.available = baseTokenInfo.available.sub(response.base);
        quoteTokenInfo.available = quoteTokenInfo.available.add(response.fee).sub(response.quote);
        _addOpenNotionalFraction(trader, params.baseToken, response.quote.toInt256());

        emit LiquidityChanged(
            trader,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.liquidity.toInt128(),
            response.fee
        );
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        nonReentrant()
        checkDeadline(params.deadline)
        returns (
            uint256 base,
            uint256 quote,
            uint256 fee
        )
    {
        _requireHasBaseToken(params.baseToken);
        RemoveLiquidityResponse memory response =
            _removeLiquidity(
                InternalRemoveLiquidityParams({
                    maker: _msgSender(),
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

        // price slippage check
        require(response.base >= params.minBase && response.quote >= params.minQuote, "CH_PSC");
        return (response.base, response.quote, response.fee);
    }

    function closePosition(address baseToken, uint160 sqrtPriceLimitX96)
        external
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        _requireHasBaseToken(baseToken);
        SwapResponse memory response = _closePosition(_msgSender(), baseToken, sqrtPriceLimitX96);
        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    function openPosition(OpenPositionParams memory params) external returns (uint256 deltaBase, uint256 deltaQuote) {
        _requireHasBaseToken(params.baseToken);
        _registerBaseToken(_msgSender(), params.baseToken);

        // must before price impact check
        Exchange(exchange).saveTickBeforeFirstSwapThisBlock(params.baseToken);

        // !isIncreasePosition() == reduce or close position
        if (!_isIncreasePosition(_msgSender(), params.baseToken, params.isBaseToQuote)) {
            // revert if isOverPriceLimit to avoid that partially closing a position in openPosition() seems unexpected
            // CH_OPI: over price impact
            require(
                !Exchange(exchange).isOverPriceLimit(
                    Exchange.PriceLimitParams({
                        baseToken: params.baseToken,
                        isBaseToQuote: params.isBaseToQuote,
                        isExactInput: params.isExactInput,
                        amount: params.amount,
                        sqrtPriceLimitX96: params.sqrtPriceLimitX96
                    })
                ),
                "CH_OPI"
            );
        }

        SwapResponse memory response =
            _openPosition(
                InternalOpenPositionParams({
                    trader: _msgSender(),
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    skipMarginRequirementCheck: false
                })
            );

        return (response.deltaAvailableBase, response.deltaAvailableQuote);
    }

    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data // contains baseToken
    ) external override {
        // CH_FMV: failed mintCallback verification
        require(_msgSender() == exchange, "CH_FMV");

        address baseToken = abi.decode(data, (address));
        address pool = _poolMap[baseToken];

        if (amount0Owed > 0) {
            TransferHelper.safeTransfer(IUniswapV3Pool(pool).token0(), pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            TransferHelper.safeTransfer(IUniswapV3Pool(pool).token1(), pool, amount1Owed);
        }
    }

    function setLiquidationPenaltyRatio(uint256 liquidationPenaltyRatioArg)
        external
        checkRatio(liquidationPenaltyRatioArg)
        onlyOwner
    {
        liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function setTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        twapInterval = twapIntervalArg;
        // TODO event declaration and emit here
    }

    function setPartialCloseRatio(uint256 partialCloseRatioArg) external checkRatio(partialCloseRatioArg) onlyOwner {
        partialCloseRatio = partialCloseRatioArg;
        emit PartialCloseRatioChanged(partialCloseRatioArg);
    }

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg) external onlyOwner {
        // TODO remove after move callback to exchange
        Exchange(exchange).setInsuranceFundFeeRatio(baseToken, insuranceFundFeeRatioArg);
    }

    function setFeeRatio(address baseToken, uint24 feeRatio) external onlyOwner {
        // TODO remove after move callback to exchange
        Exchange(exchange).setFeeRatio(baseToken, feeRatio);
    }

    function setMaxMarketsPerAccount(uint8 maxMarketsPerAccountArg) external onlyOwner {
        maxMarketsPerAccount = maxMarketsPerAccountArg;
    }

    function liquidate(address trader, address baseToken) external nonReentrant() {
        _requireHasBaseToken(baseToken);
        // CH_EAV: enough account value
        require(
            getAccountValue(trader).lt(_getTotalMinimumMarginRequirement(trader).toInt256(), _settlementTokenDecimals),
            "CH_EAV"
        );

        address[] memory tokens = _accountMap[trader].tokens;
        for (uint256 i = 0; i < tokens.length; i++) {
            bytes32[] memory orderIds = Exchange(exchange).getOpenOrderIds(trader, tokens[i]);
            // CH_NEO: not empty order
            require(orderIds.length == 0, "CH_NEO");
        }

        SwapResponse memory response = _closePosition(trader, baseToken, 0);

        // trader's pnl-- as liquidation penalty
        uint256 liquidationFee = response.exchangedPositionNotional.mul(liquidationPenaltyRatio).divideBy10_18();
        _accountMap[trader].owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(liquidationFee.toInt256());

        // increase liquidator's pnl liquidation reward
        address liquidator = _msgSender();
        _accountMap[liquidator].owedRealizedPnl = _accountMap[liquidator].owedRealizedPnl.add(
            liquidationFee.toInt256()
        );

        emit PositionLiquidated(
            trader,
            baseToken,
            response.exchangedPositionNotional,
            response.deltaAvailableBase,
            liquidationFee,
            liquidator
        );
    }

    // TODO remove after fixing quoter
    function uniswapFeeRatioMap(address pool) external returns (uint24) {
        return Exchange(exchange).uniswapFeeRatioMap(pool);
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // CH_FMV: failed mintCallback verification
        require(_msgSender() == exchange, "CH_FMV");

        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        Exchange.SwapCallbackData memory callbackData = abi.decode(data, (Exchange.SwapCallbackData));
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[callbackData.baseToken]);

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0 ? (pool.token0(), uint256(amount0Delta)) : (pool.token1(), uint256(amount1Delta));

        // we know the exact amount of a token needed for swap in the swap callback
        // we separate into two part
        // 1. extra minted tokens because the fee is charged by CH now
        // 2. tokens that a trader needs when openPosition
        //
        // check here for the design of custom fee ,
        // https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb
        // y = clearingHouseFeeRatio, x = uniswapFeeRatio

        // 1. fee charged by CH
        // because the amountToPay is scaled up,
        // we need to scale down the amount to get the exact user's input amount
        // the difference of these two values is minted for compensate the base/quote fee
        // here is an example for custom fee
        //  - clearing house fee: 2%, uniswap fee: 1%, use input with exact input: 1 quote
        //    our input to uniswap pool will be 1 * 0.98 / 0.99, and amountToPay is the same
        //    the `exactSwappedAmount` is (1 * 0.98 / 0.99) * 0.99 = 0.98
        //    the fee for uniswap pool is (1 * 0.98 / 0.99) * 0.01  <-- we need to mint
        uint256 exactSwappedAmount = FeeMath.calcScaledAmount(amountToPay, callbackData.uniswapFeeRatio, false);
        // not use _mint() here since it will change trader's baseToken available/debt
        IMintableERC20(token).mint(address(this), amountToPay.sub(exactSwappedAmount));

        // 2. openPosition
        if (callbackData.mintForTrader) {
            uint256 availableBefore = getTokenInfo(callbackData.trader, token).available;
            // if quote to base, need to mint clearing house quote fee for trader
            uint256 amount =
                token == callbackData.baseToken ? exactSwappedAmount : exactSwappedAmount.add(callbackData.fee);

            if (availableBefore < amount) {
                _mint(callbackData.trader, token, amount.sub(availableBefore), false);
            }
        }

        // swap
        TransferHelper.safeTransfer(token, address(pool), amountToPay);
    }

    function _cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] memory orderIds
    ) private {
        _requireHasBaseToken(baseToken);

        // CH_EAV: enough account value
        // shouldn't cancel open orders
        require(
            getAccountValue(maker).lt(_getTotalInitialMarginRequirement(maker).toInt256(), _settlementTokenDecimals),
            "CH_EAV"
        );

        for (uint256 i = 0; i < orderIds.length; i++) {
            bytes32 orderId = orderIds[i];
            Exchange.OpenOrder memory openOrder = Exchange(exchange).getOpenOrderById(orderId);
            _removeLiquidity(
                InternalRemoveLiquidityParams(
                    maker,
                    baseToken,
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    openOrder.liquidity
                )
            );

            // burn maker's debt to reduce maker's init margin requirement
            _burnMax(maker, baseToken);
        }

        // burn maker's quote to reduce maker's init margin requirement
        _burnMax(maker, quoteToken);
    }

    function cancelExcessOrders(
        address maker,
        address baseToken,
        bytes32[] calldata orderIds
    ) external nonReentrant() {
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    function cancelAllExcessOrders(address maker, address baseToken) external nonReentrant() {
        bytes32[] memory orderIds = Exchange(exchange).getOpenOrderIds(maker, baseToken);
        _cancelExcessOrders(maker, baseToken, orderIds);
    }

    function settle(address account) external override returns (int256) {
        // only vault
        require(_msgSender() == vault, "CH_OV");

        Account storage accountStorage = _accountMap[account];
        int256 pnl = accountStorage.owedRealizedPnl;
        accountStorage.owedRealizedPnl = 0;

        // TODO should check quote in pool as well
        if (accountStorage.tokens.length > 0) {
            return pnl;
        }

        // settle quote if all position are closed
        TokenInfo storage quoteInfo = _accountMap[account].tokenInfoMap[quoteToken];
        if (quoteInfo.available >= quoteInfo.debt) {
            // profit
            uint256 profit = quoteInfo.available.sub(quoteInfo.debt);
            quoteInfo.available = quoteInfo.available.sub(profit);
            pnl = pnl.add(profit.toInt256());

            // burn profit in quote and add to collateral
            IMintableERC20(quoteToken).burn(profit);
        } else {
            // loss
            uint256 loss = quoteInfo.debt.sub(quoteInfo.available);
            quoteInfo.debt = quoteInfo.debt.sub(loss);
            pnl = pnl.sub(loss.toInt256());
        }
        return pnl;
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPool(address baseToken) external view returns (address) {
        return _poolMap[baseToken];
    }

    function getFeeRatio(address baseToken) external view returns (uint24) {
        return Exchange(exchange).getFeeRatio(baseToken);
    }

    function getMaxTickCrossedWithinBlock(address baseToken) external view returns (uint256) {
        return Exchange(exchange).getMaxTickCrossedWithinBlock(baseToken);
    }

    // return in settlement token decimals
    function getAccountValue(address account) public view returns (int256) {
        return _getTotalCollateralValue(account).addS(getTotalUnrealizedPnl(account), _settlementTokenDecimals);
    }

    // (totalBaseDebtValue + totalQuoteDebtValue) * imRatio
    function getTotalOpenOrderMarginRequirement(address trader) external view returns (uint256) {
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = _accountMap[trader].tokenInfoMap[quoteToken].debt;
        return _getTotalBaseDebtValue(trader).add(quoteDebtValue).mul(imRatio).divideBy10_18();
    }

    // NOTE: the negative value will only be used when calculating pnl
    function getPositionValue(
        address trader,
        address token,
        uint256 twapIntervalArg
    ) public view returns (int256 positionValue) {
        int256 positionSize = _getPositionSize(trader, token, Exchange(exchange).getSqrtMarkPriceX96(token));
        if (positionSize == 0) return 0;

        uint256 indexTwap = IIndexPrice(token).getIndexPrice(twapIntervalArg);

        // both positionSize & indexTwap are in 10^18 already
        return positionSize.mul(indexTwap.toInt256()).divideBy10_18();
    }

    function getTokenInfo(address trader, address token) public view returns (TokenInfo memory) {
        return _accountMap[trader].tokenInfoMap[token];
    }

    function getOpenNotional(address trader, address baseToken) public view returns (int256) {
        // quote.pool[baseToken] + quote.owedFee[baseToken] - openNotionalFraction[baseToken]
        uint160 sqrtMarkPrice = Exchange(exchange).getSqrtMarkPriceX96(baseToken);
        int256 quoteInPool =
            Exchange(exchange).getTotalTokenAmountInPool(trader, baseToken, sqrtMarkPrice, false).toInt256();
        int256 openNotionalFraction = _openNotionalFractionMap[_getAccountBaseTokenKey(trader, baseToken)];
        return quoteInPool.sub(openNotionalFraction);
    }

    function getOwedRealizedPnl(address trader) external view returns (int256) {
        return _accountMap[trader].owedRealizedPnl;
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (Exchange.OpenOrder memory) {
        return Exchange(exchange).getOpenOrder(trader, baseToken, lowerTick, upperTick);
    }

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return Exchange(exchange).getOpenOrderIds(trader, baseToken);
    }

    function getTotalTokenAmountInPool(address trader, address baseToken)
        public
        view
        returns (uint256 base, uint256 quote)
    {
        uint160 sqrtMarkPriceX96 = Exchange(exchange).getSqrtMarkPriceX96(baseToken);
        base = Exchange(exchange).getTotalTokenAmountInPool(trader, baseToken, sqrtMarkPriceX96, true);
        quote = Exchange(exchange).getTotalTokenAmountInPool(trader, baseToken, sqrtMarkPriceX96, false);
    }

    function getPositionSize(address trader, address baseToken) public view returns (int256) {
        return _getPositionSize(trader, baseToken, Exchange(exchange).getSqrtMarkPriceX96(baseToken));
    }

    // quote.available - quote.debt + totalQuoteFromEachPool - pendingFundingPayment
    function getNetQuoteBalance(address trader) public view returns (int256) {
        uint256 quoteInPool;
        uint256 tokenLen = _accountMap[trader].tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            quoteInPool = quoteInPool.add(
                Exchange(exchange).getTotalTokenAmountInPool(
                    trader,
                    baseToken,
                    Exchange(exchange).getSqrtMarkPriceX96(baseToken),
                    false // fetch quote token amount
                )
            );
        }

        TokenInfo memory quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        int256 netQuoteBalance =
            quoteTokenInfo.available.toInt256().add(quoteInPool.toInt256()).sub(quoteTokenInfo.debt.toInt256());
        return netQuoteBalance.abs() < _DUST ? 0 : netQuoteBalance;
    }

    /// @return fundingPayment; > 0 is payment and < 0 is receipt
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        return _getPendingFundingPayment(trader, baseToken, _getUpdatedGlobalFundingGrowth(baseToken));
    }

    /// @return fundingPayment; > 0 is payment and < 0 is receipt
    function getAllPendingFundingPayment(address trader) external view returns (int256) {
        return _getAllPendingFundingPayment(trader);
    }

    function getTotalUnrealizedPnl(address trader) public view returns (int256) {
        int256 totalPositionValue;
        uint256 tokenLen = _accountMap[trader].tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_isPoolExistent(baseToken)) {
                totalPositionValue = totalPositionValue.add(getPositionValue(trader, baseToken, 0));
            }
        }

        return getNetQuoteBalance(trader).add(totalPositionValue);
    }

    //
    // INTERNAL FUNCTIONS
    //

    function _mint(
        address account,
        address token,
        uint256 amount,
        bool checkMarginRatio
    ) private returns (uint256) {
        if (amount == 0) {
            return 0;
        }

        // update internal states
        TokenInfo storage tokenInfo = _accountMap[account].tokenInfoMap[token];
        tokenInfo.available = tokenInfo.available.add(amount);
        tokenInfo.debt = tokenInfo.debt.add(amount);

        // check margin ratio must after minted
        if (checkMarginRatio) {
            _requireLargerThanInitialMarginRequirement(account);
        }

        IMintableERC20(token).mint(address(this), amount);

        emit Minted(account, token, amount);
        return amount;
    }

    // caller must ensure the token exists
    function _burn(
        address account,
        address token,
        uint256 amount
    ) private {
        if (amount == 0) {
            return;
        }

        TokenInfo storage tokenInfo = _accountMap[account].tokenInfoMap[token];
        // CH_IBTB: insufficient balance to burn
        // can only burn the amount of debt that can be pay back with available
        require(amount <= Math.min(tokenInfo.debt, tokenInfo.available), "CH_IBTB");

        // pay back debt
        tokenInfo.available = tokenInfo.available.sub(amount);
        tokenInfo.debt = tokenInfo.debt.sub(amount);

        if (token != quoteToken) {
            _deregisterBaseToken(account, token);
        }

        IMintableERC20(token).burn(amount);

        emit Burned(account, token, amount);
    }

    function _burnMax(address account, address token) private {
        TokenInfo memory tokenInfo = getTokenInfo(account, token);
        uint256 burnedAmount = Math.min(tokenInfo.available, tokenInfo.debt);
        if (burnedAmount > 0) {
            _burn(account, token, Math.min(burnedAmount, IERC20Metadata(token).balanceOf(address(this))));
        }
    }

    // expensive
    function _deregisterBaseToken(address account, address baseToken) private {
        // TODO add test: open long, add pool, now tokenInfo is cleared,
        TokenInfo memory tokenInfo = _accountMap[account].tokenInfoMap[baseToken];
        if (tokenInfo.available > 0 || tokenInfo.debt > 0) {
            return;
        }

        (uint256 baseInPool, uint256 quoteInPool) = getTotalTokenAmountInPool(account, baseToken);
        if (baseInPool > 0 || quoteInPool > 0) {
            return;
        }

        delete _accountMap[account].tokenInfoMap[baseToken];

        uint256 length = _accountMap[account].tokens.length;
        for (uint256 i; i < length; i++) {
            if (_accountMap[account].tokens[i] == baseToken) {
                // if the removal item is the last one, just `pop`
                if (i != length - 1) {
                    _accountMap[account].tokens[i] = _accountMap[account].tokens[length - 1];
                }
                _accountMap[account].tokens.pop();
                break;
            }
        }
    }

    function _registerBaseToken(address trader, address token) private {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
            return;
        }

        // if both available and debt == 0, token is not yet registered by any external function (ex: mint, burn, swap)
        TokenInfo memory tokenInfo = _accountMap[trader].tokenInfoMap[token];
        if (tokenInfo.available == 0 && tokenInfo.debt == 0) {
            bool hit;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == token) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                // CH_MNE: markets number exceeded
                require(maxMarketsPerAccount == 0 || tokens.length < maxMarketsPerAccount, "CH_MNE");
                _accountMap[trader].tokens.push(token);
            }
        }
    }

    // TODO refactor
    function _swapAndCalculateOpenNotional(InternalSwapParams memory params) private returns (SwapResponse memory) {
        int256 positionSize = getPositionSize(params.trader, params.baseToken);
        int256 oldOpenNotional = getOpenNotional(params.trader, params.baseToken);
        SwapResponse memory response;
        int256 deltaAvailableQuote;

        // if: increase position (old/new position are in the same direction)
        if (_isIncreasePosition(params.trader, params.baseToken, params.isBaseToQuote)) {
            response = _swap(params);

            // TODO change _swap.response.deltaAvailableQuote to int
            // after swapCallback mint task
            deltaAvailableQuote = params.isBaseToQuote
                ? response.deltaAvailableQuote.toInt256()
                : -response.deltaAvailableQuote.toInt256();

            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=813431512
            // taker:
            // step 1: long 20 base
            // deltaAvailableQuote = -252.53
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 0 - (-252.53) + 0 = 252.53
            // openNotional = -openNotionalFraction = -252.53
            _addOpenNotionalFraction(params.trader, params.baseToken, -deltaAvailableQuote);

            // there is no realizedPnl when increasing position
            return response;
        }

        // else: openReversePosition
        response = _swap(params);

        uint256 positionSizeAbs = positionSize.abs();

        // position size based closedRatio
        uint256 closedRatio = FullMath.mulDiv(response.deltaAvailableBase, 1 ether, positionSizeAbs);

        // TODO change _swap.response.deltaAvailableQuote to int
        deltaAvailableQuote = params.isBaseToQuote
            ? response.deltaAvailableQuote.toInt256()
            : -response.deltaAvailableQuote.toInt256();

        int256 realizedPnl;
        // if reduce or close position (closeRatio <= 1)
        if (positionSizeAbs >= response.deltaAvailableBase) {
            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 10 base (reduce half of the position)
            // deltaAvailableQuote = 137.5
            // closeRatio = 10/20 = 0.5
            // reducedOpenNotional = oldOpenNotional * closedRatio = -252.53 * 0.5 = -126.265
            // realizedPnl = deltaAvailableQuote + reducedOpenNotional = 137.5 + -126.265 = 11.235
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 252.53 - 137.5 + 11.235 = 126.265
            // openNotional = -openNotionalFraction = 126.265
            int256 reducedOpenNotional = oldOpenNotional.mul(closedRatio.toInt256()).divideBy10_18();
            realizedPnl = deltaAvailableQuote.add(reducedOpenNotional);
        } else {
            // else: opens a larger reverse position

            // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=668982944
            // taker:
            // step 1: long 20 base
            // openNotionalFraction = 252.53
            // openNotional = -252.53
            // step 2: short 30 base (open a larger reverse position)
            // deltaAvailableQuote = 337.5
            // closeRatio = 30/20 = 1.5
            // closedPositionNotional = deltaAvailableQuote / closeRatio = 337.5 / 1.5 = 225
            // remainsPositionNotional = deltaAvailableQuote - closedPositionNotional = 337.5 - 225 = 112.5
            // realizedPnl = closedPositionNotional + oldOpenNotional = -252.53 + 225 = -27.53
            // openNotionalFraction = oldOpenNotionalFraction - deltaAvailableQuote + realizedPnl
            //                      = 252.53 - 337.5 + -27.53 = -112.5
            // openNotional = -openNotionalFraction = remainsPositionNotional = 112.5
            int256 closedPositionNotional = deltaAvailableQuote.mul(1 ether).div(closedRatio.toInt256());
            realizedPnl = oldOpenNotional.add(closedPositionNotional);
        }

        _addOpenNotionalFraction(params.trader, params.baseToken, realizedPnl.sub(deltaAvailableQuote));
        _realizePnl(params.trader, realizedPnl);
        return response;
    }

    // caller must ensure there's enough quote available and debt
    function _realizePnl(address account, int256 deltaPnl) private {
        if (deltaPnl == 0) {
            return;
        }

        // TODO refactor with settle()
        _accountMap[account].owedRealizedPnl = _accountMap[account].owedRealizedPnl.add(deltaPnl);

        TokenInfo storage quoteTokenInfo = _accountMap[account].tokenInfoMap[quoteToken];
        uint256 deltaPnlAbs = deltaPnl.abs();
        // has profit
        if (deltaPnl > 0) {
            quoteTokenInfo.available = quoteTokenInfo.available.sub(deltaPnlAbs);
            IMintableERC20(quoteToken).burn(deltaPnlAbs);
            return;
        }

        // deltaPnl < 0 (has loss)
        if (deltaPnlAbs > quoteTokenInfo.debt) {
            // increase quote.debt enough so that subtraction wil not underflow
            _mint(account, quoteToken, deltaPnlAbs.sub(quoteTokenInfo.debt), false);
        }
        quoteTokenInfo.debt = quoteTokenInfo.debt.sub(deltaPnlAbs);
    }

    // check here for custom fee design,
    // https://www.notion.so/perp/Customise-fee-tier-on-B2QFee-1b7244e1db63416c8651e8fa04128cdb
    // y = clearingHouseFeeRatio, x = uniswapFeeRatio
    function _swap(InternalSwapParams memory params) private returns (SwapResponse memory) {
        Funding.Growth memory updatedGlobalFundingGrowth =
            _settleFundingAndUpdateFundingGrowth(params.trader, params.baseToken);

        Exchange.SwapResponse memory response =
            Exchange(exchange).swap(
                Exchange.SwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    updatedGlobalFundingGrowth: updatedGlobalFundingGrowth,
                    mintForTrader: params.mintForTrader
                })
            );

        {
            // update internal states
            // examples:
            // https://www.figma.com/file/xuue5qGH4RalX7uAbbzgP3/swap-accounting-and-events?node-id=0%3A1
            TokenInfo storage baseTokenInfo = _accountMap[params.trader].tokenInfoMap[params.baseToken];
            TokenInfo storage quoteTokenInfo = _accountMap[params.trader].tokenInfoMap[quoteToken];

            baseTokenInfo.available = baseTokenInfo
                .available
                .toInt256()
                .add(response.exchangedPositionSize)
                .toUint256();
            quoteTokenInfo.available = quoteTokenInfo
                .available
                .toInt256()
                .add(response.exchangedPositionNotional)
                .toUint256()
                .sub(response.fee);

            _accountMap[insuranceFund].owedRealizedPnl = _accountMap[insuranceFund].owedRealizedPnl.add(
                response.insuranceFundFee.toInt256()
            );
        }

        {
            // update timestamp of the first tx in this market
            if (_firstTradedTimestampMap[params.baseToken] == 0) {
                _firstTradedTimestampMap[params.baseToken] = _blockTimestamp();
            }
        }

        emit Swapped(
            params.trader,
            params.baseToken,
            response.exchangedPositionSize,
            response.exchangedPositionNotional,
            response.fee
        );

        return
            SwapResponse(
                response.exchangedPositionSize.abs(), // deltaAvailableBase
                response.exchangedPositionNotional.sub(response.fee.toInt256()).abs(), // deltaAvailableQuote
                response.exchangedPositionSize.abs(),
                response.exchangedPositionNotional.abs()
            );
    }

    struct RemoveLiquidityResponse {
        uint256 base;
        uint256 quote;
        uint256 fee;
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params)
        private
        returns (RemoveLiquidityResponse memory)
    {
        _settleFundingAndUpdateFundingGrowth(params.maker, params.baseToken);
        Exchange.RemoveLiquidityResponse memory response;
        {
            uint256 baseBalanceBefore = IERC20Metadata(params.baseToken).balanceOf(address(this));
            uint256 quoteBalanceBefore = IERC20Metadata(quoteToken).balanceOf(address(this));

            response = Exchange(exchange).removeLiquidity(
                Exchange.RemoveLiquidityParams({
                    maker: params.maker,
                    baseToken: params.baseToken,
                    lowerTick: params.lowerTick,
                    upperTick: params.upperTick,
                    liquidity: params.liquidity
                })
            );

            // burn base/quote fee
            // base/quote fee of all makers in the range of lowerTick and upperTick should be
            // balanceAfter - balanceBefore - response.base / response.quote
            IMintableERC20(params.baseToken).burn(
                IERC20Metadata(params.baseToken).balanceOf(address(this)).sub(baseBalanceBefore).sub(response.base)
            );
            IMintableERC20(quoteToken).burn(
                IERC20Metadata(quoteToken).balanceOf(address(this)).sub(quoteBalanceBefore).sub(response.quote)
            );
        }
        {
            uint256 removedQuoteAmount = response.quote.add(response.fee);
            TokenInfo storage baseTokenInfo = _accountMap[params.maker].tokenInfoMap[params.baseToken];
            TokenInfo storage quoteTokenInfo = _accountMap[params.maker].tokenInfoMap[quoteToken];
            baseTokenInfo.available = baseTokenInfo.available.add(response.base);
            quoteTokenInfo.available = quoteTokenInfo.available.add(removedQuoteAmount);
            _addOpenNotionalFraction(params.maker, params.baseToken, -(removedQuoteAmount.toInt256()));
        }

        emit LiquidityChanged(
            params.maker,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            -response.base.toInt256(),
            -response.quote.toInt256(),
            -params.liquidity.toInt128(),
            response.fee
        );

        return RemoveLiquidityResponse({ quote: response.quote, base: response.base, fee: response.fee });
    }

    function _openPosition(InternalOpenPositionParams memory params) private returns (SwapResponse memory) {
        SwapResponse memory swapResponse =
            _swapAndCalculateOpenNotional(
                InternalSwapParams({
                    trader: params.trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                    mintForTrader: true
                })
            );

        _burnMax(params.trader, params.baseToken);
        _burnMax(params.trader, quoteToken);
        _deregisterBaseToken(params.trader, params.baseToken);

        // if this is the last position being closed, settle the remaining quote
        // must after burnMax(quote)
        if (_accountMap[params.trader].tokens.length == 0) {
            TokenInfo memory quoteTokenInfo = getTokenInfo(params.trader, quoteToken);
            _realizePnl(params.trader, quoteTokenInfo.available.toInt256().sub(quoteTokenInfo.debt.toInt256()));
        }

        if (!params.skipMarginRequirementCheck) {
            // it's not closing the position, check margin ratio
            _requireLargerThanInitialMarginRequirement(params.trader);
        }

        return swapResponse;
    }

    function _closePosition(
        address trader,
        address baseToken,
        uint160 sqrtPriceLimitX96
    ) private returns (SwapResponse memory) {
        int256 positionSize = getPositionSize(trader, baseToken);

        // CH_PSZ: position size is zero
        require(positionSize != 0, "CH_PSZ");

        // must before price impact check
        Exchange(exchange).saveTickBeforeFirstSwapThisBlock(baseToken);

        // if trader is on long side, baseToQuote: true, exactInput: true
        // if trader is on short side, baseToQuote: false (quoteToBase), exactInput: false (exactOutput)
        bool isLong = positionSize > 0 ? true : false;

        Exchange.PriceLimitParams memory params =
            Exchange.PriceLimitParams({
                baseToken: baseToken,
                isBaseToQuote: isLong,
                isExactInput: isLong,
                amount: positionSize.abs(),
                sqrtPriceLimitX96: sqrtPriceLimitX96
            });

        // simulate the tx to see if it isOverPriceLimit; if true, partially close the position
        if (partialCloseRatio > 0 && Exchange(exchange).isOverPriceLimit(params)) {
            params.amount = params.amount.mul(partialCloseRatio).divideBy10_18();
        }

        return
            _openPosition(
                InternalOpenPositionParams({
                    trader: trader,
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: sqrtPriceLimitX96,
                    skipMarginRequirementCheck: true
                })
            );
    }

    function _addOpenNotionalFraction(
        address account,
        address baseToken,
        int256 delta
    ) private {
        bytes32 accountBaseTokenId = _getAccountBaseTokenKey(account, baseToken);
        _openNotionalFractionMap[accountBaseTokenId] = _openNotionalFractionMap[accountBaseTokenId].add(delta);
    }

    function _settleFundingAndUpdateFundingGrowth(address trader, address baseToken)
        private
        returns (Funding.Growth memory updatedGlobalFundingGrowth)
    {
        updatedGlobalFundingGrowth = _getUpdatedGlobalFundingGrowth(baseToken);
        int256 fundingPayment =
            _getPendingFundingPaymentAndUpdateLastFundingGrowth(trader, baseToken, updatedGlobalFundingGrowth);

        if (fundingPayment != 0) {
            _accountMap[trader].owedRealizedPnl = _accountMap[trader].owedRealizedPnl.sub(fundingPayment);
            emit FundingSettled(trader, baseToken, fundingPayment);
        }

        // only update in the first tx of a block
        if (_lastSettledTimestampMap[baseToken] != _blockTimestamp()) {
            Funding.Growth storage outdatedGlobalFundingGrowth = _globalFundingGrowthX96Map[baseToken];
            (
                _lastSettledTimestampMap[baseToken],
                outdatedGlobalFundingGrowth.twPremiumX96,
                outdatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
            ) = (
                _blockTimestamp(),
                updatedGlobalFundingGrowth.twPremiumX96,
                updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
            );

            emit GlobalFundingGrowthUpdated(
                baseToken,
                updatedGlobalFundingGrowth.twPremiumX96,
                updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
            );
        }
    }

    // TODO move to exchange
    function _getPendingFundingPaymentAndUpdateLastFundingGrowth(
        address trader,
        address baseToken,
        Funding.Growth memory updatedGlobalFundingGrowth
    ) private returns (int256 fundingPayment) {
        _requireHasBaseToken(baseToken);

        int256 liquidityCoefficientInFundingPayment =
            Exchange(exchange).getPendingFundingPaymentAndUpdateLastFundingGrowth(
                trader,
                baseToken,
                updatedGlobalFundingGrowth
            );

        Account storage account = _accountMap[trader];
        int256 availableAndDebtCoefficientInFundingPayment =
            _getAvailableAndDebtCoefficientInFundingPayment(
                account.tokenInfoMap[baseToken],
                updatedGlobalFundingGrowth.twPremiumX96,
                account.lastTwPremiumGrowthGlobalX96Map[baseToken]
            );

        fundingPayment = liquidityCoefficientInFundingPayment.add(availableAndDebtCoefficientInFundingPayment).div(
            1 days
        );

        // update fundingGrowth of funding payment coefficient from available and debt
        account.lastTwPremiumGrowthGlobalX96Map[baseToken] = updatedGlobalFundingGrowth.twPremiumX96;
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    // -------------------------------
    // --- funding related getters ---

    function _getPendingFundingPayment(
        address trader,
        address baseToken,
        Funding.Growth memory updatedGlobalFundingGrowth
    ) private view returns (int256 fundingPayment) {
        _requireHasBaseToken(baseToken);
        Account storage account = _accountMap[trader];
        bytes32[] memory orderIds = Exchange(exchange).getOpenOrderIds(trader, baseToken);

        int256 liquidityCoefficientInFundingPayment;
        // funding of liquidity
        for (uint256 i = 0; i < orderIds.length; i++) {
            Exchange.OpenOrder memory order = Exchange(exchange).getOpenOrderById(orderIds[i]);
            Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo =
                Exchange(exchange).getTickFundingGrowthRangeInfo(
                    baseToken,
                    order.lowerTick,
                    order.upperTick,
                    updatedGlobalFundingGrowth.twPremiumX96,
                    updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96
                );

            liquidityCoefficientInFundingPayment = liquidityCoefficientInFundingPayment.add(
                _getLiquidityCoefficientInFundingPayment(order, fundingGrowthRangeInfo)
            );
        }

        int256 availableAndDebtCoefficientInFundingPayment =
            _getAvailableAndDebtCoefficientInFundingPayment(
                account.tokenInfoMap[baseToken],
                updatedGlobalFundingGrowth.twPremiumX96,
                account.lastTwPremiumGrowthGlobalX96Map[baseToken]
            );

        fundingPayment = fundingPayment
            .add(liquidityCoefficientInFundingPayment)
            .add(availableAndDebtCoefficientInFundingPayment)
            .div(1 days);
    }

    function _getAllPendingFundingPayment(address trader) private view returns (int256 fundingPayment) {
        for (uint256 i = 0; i < _accountMap[trader].tokens.length; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_isPoolExistent(baseToken)) {
                fundingPayment = fundingPayment.add(getPendingFundingPayment(trader, baseToken));
            }
        }
    }

    function _getUpdatedGlobalFundingGrowth(address baseToken)
        private
        view
        returns (Funding.Growth memory updatedGlobalFundingGrowth)
    {
        Funding.Growth storage outdatedGlobalFundingGrowth = _globalFundingGrowthX96Map[baseToken];

        uint256 lastSettledTimestamp = _lastSettledTimestampMap[baseToken];
        if (lastSettledTimestamp != _blockTimestamp() && lastSettledTimestamp != 0) {
            int256 twPremiumDeltaX96 =
                _getMarkTwapX96(baseToken)
                    .toInt256()
                    .sub(_getIndexPrice(baseToken, twapInterval).formatX10_18ToX96().toInt256())
                    .mul(_blockTimestamp().sub(lastSettledTimestamp).toInt256());

            updatedGlobalFundingGrowth.twPremiumX96 = outdatedGlobalFundingGrowth.twPremiumX96.add(twPremiumDeltaX96);

            // overflow inspection:
            // assuming premium = 1 billion (1e9), time diff = 1 year (3600 * 24 * 365)
            // log(1e9 * 2^96 * (3600 * 24 * 365) * 2^96) / log(2) = 246.8078491997 < 255
            updatedGlobalFundingGrowth.twPremiumDivBySqrtPriceX96 = outdatedGlobalFundingGrowth
                .twPremiumDivBySqrtPriceX96
                .add(
                (twPremiumDeltaX96.mul(PerpFixedPoint96.IQ96)).div(
                    uint256(Exchange(exchange).getSqrtMarkPriceX96(baseToken)).toInt256()
                )
            );
        } else {
            // if this is the latest updated block, values in _globalFundingGrowthX96Map are up-to-date already
            updatedGlobalFundingGrowth = outdatedGlobalFundingGrowth;
        }
    }

    function _getLiquidityCoefficientInFundingPayment(
        Exchange.OpenOrder memory order,
        Tick.FundingGrowthRangeInfo memory fundingGrowthRangeInfo
    ) private view returns (int256 liquidityCoefficientInFundingPayment) {
        uint160 sqrtPriceX96AtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);

        // base amount below the range
        uint256 baseAmountBelow =
            Exchange(exchange).getAmount0ForLiquidity(
                TickMath.getSqrtRatioAtTick(order.lowerTick),
                sqrtPriceX96AtUpperTick,
                order.liquidity
            );
        int256 fundingBelowX96 =
            baseAmountBelow.toInt256().mul(
                fundingGrowthRangeInfo.twPremiumGrowthBelowX96.sub(order.lastTwPremiumGrowthBelowX96)
            );

        // funding inside the range =
        // liquidity * (ΔtwPremiumDivBySqrtPriceGrowthInsideX96 - ΔtwPremiumGrowthInsideX96 / sqrtPriceAtUpperTick)
        int256 fundingInsideX96 =
            uint256(order.liquidity).toInt256().mul(
                // ΔtwPremiumDivBySqrtPriceGrowthInsideX96
                fundingGrowthRangeInfo
                    .twPremiumDivBySqrtPriceGrowthInsideX96
                    .sub(order.lastTwPremiumDivBySqrtPriceGrowthInsideX96)
                    .sub(
                    // ΔtwPremiumGrowthInsideX96
                    (
                        fundingGrowthRangeInfo.twPremiumGrowthInsideX96.sub(order.lastTwPremiumGrowthInsideX96).mul(
                            PerpFixedPoint96.IQ96
                        )
                    )
                        .div(sqrtPriceX96AtUpperTick)
                )
            );

        return fundingBelowX96.add(fundingInsideX96).div(PerpFixedPoint96.IQ96);
    }

    function _getAvailableAndDebtCoefficientInFundingPayment(
        TokenInfo memory tokenInfo,
        int256 twPremiumGrowthGlobalX96,
        int256 lastTwPremiumGrowthGlobalX96
    ) private pure returns (int256 availableAndDebtCoefficientInFundingPayment) {
        return
            tokenInfo
                .available
                .toInt256()
                .sub(tokenInfo.debt.toInt256())
                .mul(twPremiumGrowthGlobalX96.sub(lastTwPremiumGrowthGlobalX96))
                .div(PerpFixedPoint96.IQ96);
    }

    function _getMarkTwapX96(address token) private view returns (uint256) {
        uint32 twapIntervalArg = twapInterval;

        // shorten twapInterval if there is no prior observation
        if (_firstTradedTimestampMap[token] == 0) {
            twapIntervalArg = 0;
        } else if (twapIntervalArg > _blockTimestamp().sub(_firstTradedTimestampMap[token])) {
            // overflow inspection:
            // 2 ^ 32 = 4,294,967,296 > 100 years = 60 * 60 * 24 * 365 * 100 = 3,153,600,000
            twapIntervalArg = uint32(_blockTimestamp().sub(_firstTradedTimestampMap[token]));
        }

        return Exchange(exchange).getSqrtMarkTwapX96(token, twapIntervalArg);
    }

    // --- funding related getters ---
    // -------------------------------

    function _getIndexPrice(address token, uint256 twapIntervalArg) private view returns (uint256) {
        // TODO funding
        // decide on whether we should use twapInterval the state or the input twapIntervalArg
        // if we use twapInterval, we might need a require() or might not, as the lower level will might deal with it
        return IIndexPrice(token).getIndexPrice(twapIntervalArg);
    }

    // return decimals 18
    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = _accountMap[trader].tokenInfoMap[quoteToken].debt;
        uint256 totalPositionValue = _getTotalAbsPositionValue(trader);
        uint256 totalBaseDebtValue = _getTotalBaseDebtValue(trader);
        return Math.max(totalPositionValue, totalBaseDebtValue.add(quoteDebtValue)).mul(imRatio).divideBy10_18();
    }

    function _getTotalMinimumMarginRequirement(address trader) internal view returns (uint256) {
        return _getTotalAbsPositionValue(trader).mul(mmRatio).divideBy10_18();
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(_getIndexPrice(token, 0)).divideBy10_18();
    }

    // return in settlement token decimals
    function _getTotalCollateralValue(address trader) private view returns (int256) {
        int256 owedRealizedPnl = _accountMap[trader].owedRealizedPnl;
        return
            IVault(vault).balanceOf(trader).toInt256().addS(
                owedRealizedPnl.sub(_getAllPendingFundingPayment(trader)),
                _settlementTokenDecimals
            );
    }

    // TODO refactor with _getTotalBaseDebtValue and getTotalUnrealizedPnl
    function _getTotalAbsPositionValue(address trader) private view returns (uint256) {
        address[] memory tokens = _accountMap[trader].tokens;
        uint256 totalPositionValue;
        uint256 tokenLen = tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = tokens[i];
            if (_isPoolExistent(baseToken)) {
                // will not use negative value in this case
                uint256 positionValue = getPositionValue(trader, baseToken, 0).abs();
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }
        return totalPositionValue;
    }

    function _getTotalBaseDebtValue(address trader) private view returns (uint256) {
        Account storage account = _accountMap[trader];
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                uint256 baseDebtValue = _getDebtValue(baseToken, account.tokenInfoMap[baseToken].debt);
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
            }
        }
        return totalBaseDebtValue;
    }

    function _getPositionSize(
        address trader,
        address baseToken,
        uint160 sqrtMarkPriceX96
    ) private view returns (int256) {
        TokenInfo memory baseTokenInfo = _accountMap[trader].tokenInfoMap[baseToken];
        uint256 vBaseAmount =
            baseTokenInfo.available.add(
                Exchange(exchange).getTotalTokenAmountInPool(
                    trader,
                    baseToken,
                    sqrtMarkPriceX96,
                    true // get base token amount
                )
            );

        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize = vBaseAmount.toInt256().sub(baseTokenInfo.debt.toInt256());
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    function _isPoolExistent(address baseToken) internal view returns (bool) {
        return _poolMap[baseToken] != address(0);
    }

    function _isIncreasePosition(
        address trader,
        address baseToken,
        bool isBaseToQuote
    ) private view returns (bool) {
        // increase position == old/new position are in the same direction
        int256 positionSize = getPositionSize(trader, baseToken);
        bool isOldPositionShort = positionSize < 0 ? true : false;
        return (positionSize == 0 || isOldPositionShort == isBaseToQuote);
    }

    function _getAccountBaseTokenKey(address account, address baseToken) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(account, baseToken));
    }

    function _requireHasBaseToken(address baseToken) private view {
        // CH_BTNE: base token not exists
        require(_isPoolExistent(baseToken), "CH_BTNE");
    }

    function _requireLargerThanInitialMarginRequirement(address trader) private view {
        // CH_NEAV: not enough account value
        require(
            getAccountValue(trader).gte(_getTotalInitialMarginRequirement(trader).toInt256(), _settlementTokenDecimals),
            "CH_NEAV"
        );
    }
}
