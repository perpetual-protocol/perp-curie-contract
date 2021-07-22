pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { ArbBlockContext } from "./util/ArbBlockContext.sol";
import { Vault } from "./Vault.sol";

contract ClearingHouse is
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback,
    ISettlement,
    ReentrancyGuard,
    ArbBlockContext,
    Ownable
{
    using SafeMath for uint256;
    using SafeMath for uint160;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SignedSafeMath for int256;
    using SafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using PerpMath for uint160;

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
        uint256 baseFee, // amount of base token the maker received as fee
        uint256 quoteFee // amount of quote token the maker received as fee
    );
    event FundingRateUpdated(int256 rate, uint256 underlyingPrice);
    event FundingSettled(
        address indexed trader,
        address indexed token,
        uint256 nextPremiumFractionIndex,
        int256 amount // +: trader pays, -: trader receives
    );

    event Swapped(
        address indexed trader,
        address indexed baseToken,
        int256 exchangedPositionSize,
        int256 costBasis,
        uint256 fee,
        int256 fundingPayment,
        uint256 badDebt
    );

    //
    // Struct
    //

    struct Account {
        address[] tokens; // all tokens (base only) this account is in debt of
        // key: token address, e.g. vETH...
        mapping(address => TokenInfo) tokenInfoMap; // balance & debt info of each token
        // @audit - suggest to flatten the mapping by keep an orderIds[] here
        // and create another _openOrderMap global state
        // because the orderId already contains the baseTokenAddr (@wraecca).
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => MakerPosition) makerPositionMap; // open orders for maker
        // key: token address, value: next premium fraction index for settling funding payment
        mapping(address => uint256) nextPremiumFractionIndexMap;
    }

    struct TokenInfo {
        uint256 available; // amount available in CH
        uint256 debt;
    }

    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideBaseX128;
        uint256 feeGrowthInsideQuoteX128;
    }

    struct MakerPosition {
        bytes32[] orderIds;
        // key: order id
        mapping(bytes32 => OpenOrder) openOrderMap;
    }

    struct FundingHistory {
        int256 premiumFractions;
        uint160 sqrtMarkPriceX96;
    }

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
    }

    /// @param liquidity collect fee when 0
    struct RemoveLiquidityParams {
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
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

    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    // 10 wei
    uint256 private constant _DUST = 10;

    //
    // state variables
    //
    uint256 public imRatio = 0.1 ether; // initial-margin ratio, 10%
    uint256 public mmRatio = 0.0625 ether; // minimum-margin ratio, 6.25%

    address public immutable quoteToken;
    address public immutable uniswapV3Factory;
    address public vault;

    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: trader
    mapping(address => Account) private _accountMap;

    uint256 public immutable fundingPeriod;
    // key: base token
    mapping(address => uint256) private _nextFundingTimeMap;
    mapping(address => FundingHistory[]) private _fundingHistoryMap;

    constructor(
        address vaultArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        uint256 fundingPeriodArg
    ) {
        // TODO: add missing full error messages
        require(vaultArg != address(0), "CH_II_C");
        require(quoteTokenArg != address(0), "CH_II_Q");
        require(uniV3FactoryArg != address(0), "CH_II_U");

        // TODO: store vault.decimals for optimizing gas
        vault = vaultArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
        fundingPeriod = fundingPeriodArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        // to ensure the base is always token0 and quote is always token1
        // CH_IB: invalid baseToken
        require(baseToken < quoteToken, "CH_IB");
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(pool != _poolMap[baseToken], "CH_EP");

        _poolMap[baseToken] = pool;
        emit PoolAdded(baseToken, feeRatio, pool);
    }

    // @audit - change to token[] amount[] for minting both (@wraecca)
    // TODO should add modifier: whenNotPaused()
    function mint(address token, uint256 amount) external nonReentrant() {
        _requireTokenExistent(token);
        // always check margin ratio
        _mint(token, amount, true);
    }

    /**
     * @param amount the amount of debt to burn
     */
    function burn(address token, uint256 amount) public nonReentrant() {
        _requireTokenExistent(token);
        _requireValidAmount(amount);

        address trader = _msgSender();

        // TODO could be optimized by letting the caller trigger it.
        //  Revise after we have defined the user-facing functions.
        if (token != quoteToken) {
            _settleFunding(trader, token);
        }

        TokenInfo storage tokenInfo = _accountMap[trader].tokenInfoMap[token];

        // CH_IA: invalid amount
        // can only burn the amount of debt that can be pay back with available
        require(amount <= Math.min(tokenInfo.debt, tokenInfo.available), "CH_IA");

        // pay back debt
        tokenInfo.available = tokenInfo.available.sub(amount);
        tokenInfo.debt = tokenInfo.debt.sub(amount);

        // FIXME remove token from account.tokens if available & debt is zero

        IMintableERC20(token).burn(amount);

        emit Burned(trader, token, amount);
    }

    function swap(SwapParams memory params) public nonReentrant() returns (UniswapV3Broker.SwapResponse memory) {
        _requireTokenExistent(params.baseToken);

        address trader = _msgSender();

        _registerBaseToken(trader, params.baseToken);

        // TODO could be optimized by letting the caller trigger it.
        // Revise after we have defined the user-facing functions.
        int256 settledFundingPayment = _settleFunding(trader, params.baseToken);

        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[params.baseToken]);
        UniswapV3Broker.SwapResponse memory response =
            UniswapV3Broker.swap(
                UniswapV3Broker.SwapParams(
                    pool,
                    params.baseToken,
                    quoteToken,
                    params.isBaseToQuote,
                    params.isExactInput,
                    params.amount,
                    params.sqrtPriceLimitX96
                )
            );

        // update internal states
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];

        if (params.isBaseToQuote) {
            baseTokenInfo.available = baseTokenInfo.available.sub(response.base);
            quoteTokenInfo.available = quoteTokenInfo.available.add(response.quote);
        } else {
            quoteTokenInfo.available = quoteTokenInfo.available.sub(response.quote);
            baseTokenInfo.available = baseTokenInfo.available.add(response.base);
        }

        emit Swapped(
            trader, // trader
            params.baseToken, // baseToken
            params.isBaseToQuote ? -response.base.toInt256() : response.base.toInt256(), // exchangedPositionSize
            params.isBaseToQuote ? response.quote.toInt256() : -response.quote.toInt256(), // costBasis
            response.fee, // fee
            settledFundingPayment, // fundingPayment,
            0 // TODO: badDebt
        );

        return response;
    }

    function addLiquidity(AddLiquidityParams calldata params) external nonReentrant() {
        _requireTokenExistent(params.baseToken);

        address trader = _msgSender();

        // register token if it's the first time
        _registerBaseToken(trader, params.baseToken);

        // TODO could be optimized by letting the caller trigger it.
        // Revise after we have defined the user-facing functions.
        _settleFunding(trader, params.baseToken);

        // update internal states
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        uint256 baseAvailable = baseTokenInfo.available;
        uint256 quoteAvailable = quoteTokenInfo.available;
        // CH_NEB: not enough available base amount
        require(baseAvailable >= params.base, "CH_NEB");
        // CH_NEB: not enough available quote amount
        require(quoteAvailable >= params.quote, "CH_NEQ");

        // add liquidity to liquidity pool
        UniswapV3Broker.AddLiquidityResponse memory response =
            UniswapV3Broker.addLiquidity(
                UniswapV3Broker.AddLiquidityParams(
                    _poolMap[params.baseToken],
                    params.baseToken,
                    quoteToken,
                    params.lowerTick,
                    params.upperTick,
                    params.base,
                    params.quote
                )
            );
        // mint callback
        // TODO add slippage protection

        // load existing open order
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        MakerPosition storage makerPosition = _accountMap[trader].makerPositionMap[params.baseToken];
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];

        uint256 baseFee;
        uint256 quoteFee;
        if (openOrder.liquidity == 0) {
            // it's a new order
            makerPosition.orderIds.push(orderId);
            openOrder.lowerTick = params.lowerTick;
            openOrder.upperTick = params.upperTick;
        } else {
            baseFee = _calcOwedFee(
                openOrder.liquidity,
                response.feeGrowthInsideBaseX128,
                openOrder.feeGrowthInsideBaseX128
            );
            quoteFee = _calcOwedFee(
                openOrder.liquidity,
                response.feeGrowthInsideQuoteX128,
                openOrder.feeGrowthInsideQuoteX128
            );
        }

        // update token info
        baseTokenInfo.available = baseAvailable.add(baseFee).sub(response.base);
        quoteTokenInfo.available = quoteAvailable.add(quoteFee).sub(response.quote);

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().add(response.liquidity.toUint256()).toUint128();
        openOrder.feeGrowthInsideBaseX128 = response.feeGrowthInsideBaseX128;
        openOrder.feeGrowthInsideQuoteX128 = response.feeGrowthInsideQuoteX128;

        // TODO move it back if we can fix stack too deep
        _emitLiquidityChanged(trader, params, response, baseFee, quoteFee);
    }

    function removeLiquidity(RemoveLiquidityParams calldata params) external nonReentrant() {
        _requireTokenExistent(params.baseToken);
        _removeLiquidity(
            InternalRemoveLiquidityParams({
                maker: _msgSender(),
                baseToken: params.baseToken,
                lowerTick: params.lowerTick,
                upperTick: params.upperTick,
                liquidity: params.liquidity
            })
        );
    }

    function openPosition(OpenPositionParams memory params) external {
        _requireTokenExistent(params.baseToken);

        address trader = _msgSender();
        uint256 baseAvailableBefore = getTokenInfo(trader, params.baseToken).available;
        uint256 quoteAvailableBefore = getTokenInfo(trader, quoteToken).available;
        uint256 minted;

        // calculate if trader need to mint more quote or base for exact input
        if (params.isExactInput) {
            if (params.isBaseToQuote) {
                // check if trader has enough base to swap
                if (baseAvailableBefore < params.amount) {
                    minted = _mint(params.baseToken, params.amount.sub(baseAvailableBefore), true);
                }
            } else {
                // check if trader has enough quote to swap
                if (quoteAvailableBefore < params.amount) {
                    minted = _mint(quoteToken, params.amount.sub(quoteAvailableBefore), true);
                }
            }
        } else {
            // for exact output: can't use quoter to get how many input we need
            // but we'll know the exact input numbers after swap
            // so we'll mint max first, do the swap
            // then calculate how many input we need to mint if we have quoter
            if (params.isBaseToQuote) {
                minted = _mintMax(params.baseToken);
            } else {
                minted = _mintMax(quoteToken);
            }
        }

        UniswapV3Broker.SwapResponse memory swapResponse =
            swap(
                SwapParams({
                    baseToken: params.baseToken,
                    isBaseToQuote: params.isBaseToQuote,
                    isExactInput: params.isExactInput,
                    amount: params.amount,
                    sqrtPriceLimitX96: params.sqrtPriceLimitX96
                })
            );

        // exactInsufficientAmount = max(actualSwapped - availableBefore, 0)
        // shouldBurn = minted - exactInsufficientAmount
        //
        // examples:
        //
        // 1.
        // before = 0, mint max +1000
        // swap 1 eth required 100 (will mint 100 if we have quoter)
        // quote = 900
        // toBurn = minted(1000) - exactInsufficientAmount(100) = 900
        // exactInsufficientAmount = max((swapped(100) - before (0)), 0) = 100
        //
        // 2.
        // before = 50, mint max +950
        // swap 1 eth required 100 (will mint 50 if we have quoter)
        // quote = 900
        // toBurn = minted(950) - exactInsufficientAmount(50) = 900
        // exactInsufficientAmount = max((swapped(100) - before (50)), 0) = 50
        //
        // 3.
        // before = 200, mint max +700
        // swap 1 eth required 100 (will mint 0 if we have quoter)
        // quote = 900
        // toBurn = minted(700) - exactInsufficientAmount(0) = 700
        // exactInsufficientAmount = max((swapped(100) - before (200)), 0) = 0
        if (params.isBaseToQuote) {
            uint256 exactInsufficientBase;
            if (swapResponse.base > baseAvailableBefore) {
                exactInsufficientBase = swapResponse.base.sub(baseAvailableBefore);
            }

            if (minted > exactInsufficientBase) {
                burn(params.baseToken, minted.sub(exactInsufficientBase));
            }
        } else {
            uint256 exactInsufficientQuote;
            if (swapResponse.quote > quoteAvailableBefore) {
                exactInsufficientQuote = swapResponse.quote.sub(quoteAvailableBefore);
            }

            if (minted > exactInsufficientQuote) {
                burn(quoteToken, minted.sub(exactInsufficientQuote));
            }
        }

        TokenInfo memory baseTokenInfo = getTokenInfo(_msgSender(), params.baseToken);
        // if it's closing the position, settle the quote to realize pnl of that market
        if (baseTokenInfo.available == 0 && baseTokenInfo.debt == 0) {
            TokenInfo memory quoteTokenInfo = getTokenInfo(_msgSender(), quoteToken);
            uint256 burnableAmount = Math.min(quoteTokenInfo.available, quoteTokenInfo.debt);
            // TODO combine 2 potential burn into 1
            burn(quoteToken, burnableAmount);
        } else {
            // it's not closing the position, check margin ratio
            _requireLargerThanInitialMarginRequirement(trader);
        }
    }

    // @audit - review security and possible attacks (@detoo)
    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data // contains baseToken
    ) external override {
        address baseToken = abi.decode(data, (address));
        address pool = _poolMap[baseToken];
        // CH_FMV: failed mintCallback verification
        require(_msgSender() == pool, "CH_FMV");

        if (amount0Owed > 0) {
            TransferHelper.safeTransfer(IUniswapV3Pool(pool).token0(), pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            TransferHelper.safeTransfer(IUniswapV3Pool(pool).token1(), pool, amount1Owed);
        }
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CH_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "CH_F0S");

        address baseToken = abi.decode(data, (address));
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[baseToken]);
        // CH_FSV: failed swapCallback verification
        require(_msgSender() == address(pool), "CH_FSV");

        // amount0Delta & amount1Delta are guaranteed to be positive when being the amount to be paid
        (address token, uint256 amountToPay) =
            amount0Delta > 0 ? (pool.token0(), uint256(amount0Delta)) : (pool.token1(), uint256(amount1Delta));
        // swap fail
        TransferHelper.safeTransfer(token, _msgSender(), amountToPay);
    }

    /**
     * @notice "pay funding" by registering the primitives for funding calculations (premiumFraction, markPrice, etc)
     * so that we can defer the actual settlement of payment later for each market and each trader, respectively,
     * therefore spread out the computational loads. It is expected to be called by a keeper every fundingPeriod.
     * @param baseToken base token address
     */
    function updateFunding(address baseToken) external {
        _requireTokenExistent(baseToken);
        // TODO should check if market is open

        // solhint-disable-next-line not-rely-on-time
        uint256 nowTimestamp = _blockTimestamp();
        // CH_UFTE update funding too early
        require(nowTimestamp >= _nextFundingTimeMap[baseToken], "CH_UFTE");

        // premium = markTwap - indexTwap
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        IUniswapV3Pool pool = IUniswapV3Pool(_poolMap[baseToken]);
        int256 premiumFraction;
        {
            uint160 sqrtMarkTwapX96 = UniswapV3Broker.getSqrtMarkTwapX96(_poolMap[baseToken], fundingPeriod);
            uint256 markTwap = sqrtMarkTwapX96.formatX96ToX10_18();
            uint256 indexTwap = _getIndexPrice(baseToken, fundingPeriod);

            int256 premium = markTwap.toInt256().sub(indexTwap.toInt256());
            premiumFraction = premium.mul(fundingPeriod.toInt256()).div(int256(1 days));

            emit FundingRateUpdated(premiumFraction.mul(1 ether).div(indexTwap.toInt256()), indexTwap);
        }

        // register primitives for funding calculations so we can settle it later
        (uint160 sqrtMarkPriceX96, , , , , , ) = pool.slot0();
        FundingHistory memory fundingHistory =
            FundingHistory({ premiumFractions: premiumFraction, sqrtMarkPriceX96: sqrtMarkPriceX96 });
        _fundingHistoryMap[baseToken].push(fundingHistory);

        // update next funding time requirements so we can prevent multiple funding settlement
        // during very short time after network congestion
        uint256 minNextValidFundingTime = nowTimestamp.add(fundingPeriod.div(2));
        // (floor(nowTimestamp / fundingPeriod) + 1) * fundingPeriod
        uint256 nextFundingTimeOnHourStart = nowTimestamp.div(fundingPeriod).add(1).mul(fundingPeriod);
        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        _nextFundingTimeMap[baseToken] = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;
    }

    function settleFunding(address trader, address token) external returns (int256 fundingPayment) {
        _requireTokenExistent(token);
        return _settleFunding(trader, token);
    }

    function cancelExcessOrders(address maker, address baseToken) external nonReentrant() {
        _requireTokenExistent(baseToken);
        // CH_EAV: enough account value
        // shouldn't cancel open orders
        require(getAccountValue(maker) < _getTotalInitialMarginRequirement(maker).toInt256(), "CH_EAV");

        bytes32[] memory orderIds = _accountMap[maker].makerPositionMap[baseToken].orderIds;
        for (uint256 i = 0; i < orderIds.length; i++) {
            bytes32 orderId = orderIds[i];
            OpenOrder memory openOrder = _accountMap[maker].makerPositionMap[baseToken].openOrderMap[orderId];
            _removeLiquidity(
                InternalRemoveLiquidityParams(
                    maker,
                    baseToken,
                    openOrder.lowerTick,
                    openOrder.upperTick,
                    openOrder.liquidity
                )
            );
        }
    }

    function settle(address account) external override returns (int256 pnl) {
        // only vault
        require(_msgSender() == vault, "CH_OV");

        // calculate pnl
        TokenInfo storage quoteInfo = _accountMap[account].tokenInfoMap[quoteToken];
        if (quoteInfo.available >= quoteInfo.debt) {
            // profit
            uint256 profit = quoteInfo.available.sub(quoteInfo.debt);
            quoteInfo.available = quoteInfo.available.sub(profit);
            pnl = profit.toInt256();

            // burn profit in quote and add to collateral
            IMintableERC20(quoteToken).burn(profit);
        } else {
            // loss
            uint256 loss = quoteInfo.debt.sub(quoteInfo.available);
            quoteInfo.debt = quoteInfo.debt.sub(loss);
            pnl = -(loss.toInt256());
        }
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPool(address baseToken) external view returns (address poolAddress) {
        return _poolMap[baseToken];
    }

    // FIXME should include pending funding payment
    function getAccountValue(address trader) public view returns (int256) {
        return IERC20Metadata(vault).balanceOf(trader).toInt256().add(getTotalMarketPnl(trader));
    }

    function buyingPower(address account) public view returns (uint256) {
        int256 requiredCollateral = getRequiredCollateral(account);
        int256 totalCollateralValue = IERC20Metadata(vault).balanceOf(account).toInt256();
        if (requiredCollateral >= totalCollateralValue) {
            return 0;
        }

        // totalCollateralValue > requiredCollateral
        return totalCollateralValue.sub(requiredCollateral).toUint256();
    }

    // TODO have a better naming
    function getTotalOpenOrderMarginRequirement(address trader) external view returns (uint256) {
        Account storage account = _accountMap[trader];

        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = account.tokenInfoMap[quoteToken].debt;
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                uint256 baseDebtValue = _getDebtValue(baseToken, account.tokenInfoMap[baseToken].debt);
                // will not use negative value in this case
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
            }
        }

        return totalBaseDebtValue.add(quoteDebtValue).mul(imRatio).divideBy10_18();
    }

    // NOTE: the negative value will only be used when calculating the PNL
    // TODO: whether this is public or internal or private
    function getPositionValue(
        address trader,
        address token,
        uint256 twapInterval
    ) public view returns (int256 positionValue) {
        int256 positionSize =
            _getPositionSize(trader, token, UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[token]), true);
        if (positionSize == 0) return 0;

        // TODO: handle if the pool's history < twapInterval; decide whether twapInterval should be a state or param
        uint160 sqrtMarkTwapX96 = UniswapV3Broker.getSqrtMarkTwapX96(_poolMap[token], twapInterval);
        uint256 markTwap = sqrtMarkTwapX96.formatX96ToX10_18();

        // both positionSize & markTwap are in 10^18 already
        return positionSize.mul(markTwap.toInt256()).divideBy10_18();
    }

    function _getIndexPrice(address token, uint256 twapInterval) private view returns (uint256) {
        return IIndexPrice(token).getIndexPrice(twapInterval);
    }

    function getTokenInfo(address trader, address token) public view returns (TokenInfo memory) {
        return _accountMap[trader].tokenInfoMap[token];
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        return
            _accountMap[trader].makerPositionMap[baseToken].openOrderMap[
                _getOrderId(trader, baseToken, lowerTick, upperTick)
            ];
    }

    function getOpenOrderIds(address trader, address baseToken) external view returns (bytes32[] memory) {
        return _accountMap[trader].makerPositionMap[baseToken].orderIds;
    }

    function getPositionSize(address trader, address baseToken) external view returns (int256) {
        return _getPositionSize(trader, baseToken, UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]), true);
    }

    // @audit do we need to expose the following function until the end of this section?
    // suggest to expose as less as we can (@wraecca)
    function getCostBasis(address trader) public view returns (int256) {
        uint256 quoteInPool;
        uint256 tokenLen = _accountMap[trader].tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            // TODO: remove quoteToken from _accountMap[trader].tokens?
            quoteInPool = quoteInPool.add(
                _getTokenAmountInPool(
                    trader,
                    baseToken,
                    UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]),
                    true,
                    false
                )
            );
        }
        TokenInfo memory quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        int256 costBasis =
            quoteTokenInfo.available.toInt256().add(quoteInPool.toInt256()).sub(quoteTokenInfo.debt.toInt256());
        return costBasis.abs() < _DUST ? 0 : costBasis;
    }

    function getNextFundingTime(address baseToken) external view returns (uint256) {
        return _nextFundingTimeMap[baseToken];
    }

    function getPremiumFraction(address baseToken, uint256 idx) external view returns (int256) {
        return _fundingHistoryMap[baseToken][idx].premiumFractions;
    }

    function getFundingHistoryLength(address baseToken) external view returns (uint256) {
        return _fundingHistoryMap[baseToken].length;
    }

    function getSqrtMarkTwapX96(address baseToken, uint256 twapInterval) external view returns (uint160) {
        return UniswapV3Broker.getSqrtMarkTwapX96(_poolMap[baseToken], twapInterval);
    }

    function getSqrtMarkPriceX96(address baseToken) external view returns (uint160) {
        return UniswapV3Broker.getSqrtMarkPriceX96(_poolMap[baseToken]);
    }

    function getSqrtMarkPriceX96AtIndex(address baseToken, uint256 idx) external view returns (uint160) {
        return _fundingHistoryMap[baseToken][idx].sqrtMarkPriceX96;
    }

    /// @dev +: trader pays, -: trader receives
    function getPendingFundingPayment(address trader, address baseToken) public view returns (int256) {
        Account storage account = _accountMap[trader];
        int256 fundingPaymentAmount;
        {
            FundingHistory[] memory fundingHistory = _fundingHistoryMap[baseToken];
            uint256 indexEnd = fundingHistory.length;
            for (uint256 i = account.nextPremiumFractionIndexMap[baseToken]; i < indexEnd; i++) {
                int256 posSize = _getPositionSize(trader, baseToken, fundingHistory[i].sqrtMarkPriceX96, false);
                fundingPaymentAmount = fundingPaymentAmount.add(
                    fundingHistory[i].premiumFractions.mul(posSize).divideBy10_18()
                );
            }
        }
        return fundingPaymentAmount;
    }

    function getNextFundingIndex(address trader, address baseToken) external view returns (uint256) {
        return _accountMap[trader].nextPremiumFractionIndexMap[baseToken];
    }

    function getRequiredCollateral(address account) public view override returns (int256) {
        return _getTotalInitialMarginRequirement(account).toInt256().sub(getTotalMarketPnl(account));
    }

    function getTotalMarketPnl(address trader) public view returns (int256) {
        int256 totalPositionValue;
        uint256 tokenLen = _accountMap[trader].tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = _accountMap[trader].tokens[i];
            if (_isPoolExistent(baseToken)) {
                totalPositionValue = totalPositionValue.add(getPositionValue(trader, baseToken, 0));
            }
        }

        return getCostBasis(trader).add(totalPositionValue);
    }

    //
    // INTERNAL FUNCTIONS
    //

    function _mint(
        address token,
        uint256 amount,
        bool checkMarginRatio
    ) private returns (uint256) {
        _requireValidAmount(amount);

        // update internal states
        address account = _msgSender();
        TokenInfo storage tokenInfo = _accountMap[account].tokenInfoMap[token];
        tokenInfo.available = tokenInfo.available.add(amount);
        tokenInfo.debt = tokenInfo.debt.add(amount);

        if (token != quoteToken) {
            // register base token if it's the first time
            _registerBaseToken(account, token);

            // Revise after we have defined the user-facing functions.
            _settleFunding(account, token);
        }

        // check margin ratio must after minted
        if (checkMarginRatio) {
            _requireLargerThanInitialMarginRequirement(account);
        }

        IMintableERC20(token).mint(address(this), amount);

        emit Minted(account, token, amount);
        return amount;
    }

    // caller must ensure token is base or quote
    // mint max base or quote until the free collateral is zero
    function _mintMax(address token) private returns (uint256) {
        uint256 freeCollateral = buyingPower(_msgSender());
        if (freeCollateral == 0) {
            return 0;
        }

        // TODO store decimals for gas optimization
        // normalize free collateral from collateral decimals to quote decimals
        uint256 vaultDecimals = 10**IERC20Metadata(vault).decimals();
        uint256 quoteDecimals = 10**IERC20Metadata(quoteToken).decimals();
        uint256 normalizedFreeCollateral = FullMath.mulDiv(freeCollateral, quoteDecimals, vaultDecimals);
        uint256 mintableQuote = FullMath.mulDiv(normalizedFreeCollateral, quoteDecimals, imRatio);
        uint256 minted;
        if (token == quoteToken) {
            minted = mintableQuote;
        } else {
            // TODO: change the valuation method && align with baseDebt()
            minted = FullMath.mulDiv(mintableQuote, 1 ether, _getIndexPrice(token, 0));
        }

        return _mint(token, minted, false);
    }

    function _registerBaseToken(address trader, address token) private {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
        } else {
            // if available or debt are not 0,
            // token is already registered by one of external functions (ex: mint, burn, swap)
            TokenInfo memory tokenInfo = _accountMap[trader].tokenInfoMap[token];
            if (tokenInfo.available != 0 || tokenInfo.debt != 0) {
                return;
            }

            bool hit;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == token) {
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                _accountMap[trader].tokens.push(token);
            }
        }
    }

    function _removeLiquidity(InternalRemoveLiquidityParams memory params) private {
        address trader = params.maker;

        // TODO could be optimized by letting the caller trigger it.
        //  Revise after we have defined the user-facing functions.
        _settleFunding(trader, params.baseToken);

        // load existing open order
        bytes32 orderId = _getOrderId(trader, params.baseToken, params.lowerTick, params.upperTick);
        OpenOrder storage openOrder = _accountMap[trader].makerPositionMap[params.baseToken].openOrderMap[orderId];
        // CH_ZL non-existent openOrder
        require(openOrder.liquidity > 0, "CH_NEO");
        // CH_NEL not enough liquidity
        require(params.liquidity <= openOrder.liquidity, "CH_NEL");

        UniswapV3Broker.RemoveLiquidityResponse memory response =
            UniswapV3Broker.removeLiquidity(
                UniswapV3Broker.RemoveLiquidityParams(
                    _poolMap[params.baseToken],
                    params.lowerTick,
                    params.upperTick,
                    params.liquidity
                )
            );

        // TODO add slippage protection

        // update token info based on existing open order
        TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[params.baseToken];
        TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
        uint256 baseFee =
            _calcOwedFee(openOrder.liquidity, response.feeGrowthInsideBaseX128, openOrder.feeGrowthInsideBaseX128);
        uint256 quoteFee =
            _calcOwedFee(openOrder.liquidity, response.feeGrowthInsideQuoteX128, openOrder.feeGrowthInsideQuoteX128);
        baseTokenInfo.available = baseTokenInfo.available.add(baseFee).add(response.base);
        quoteTokenInfo.available = quoteTokenInfo.available.add(quoteFee).add(response.quote);

        // update open order with new liquidity
        openOrder.liquidity = openOrder.liquidity.toUint256().sub(params.liquidity.toUint256()).toUint128();
        if (openOrder.liquidity == 0) {
            _removeOrder(trader, params.baseToken, orderId);
        } else {
            openOrder.feeGrowthInsideBaseX128 = response.feeGrowthInsideBaseX128;
            openOrder.feeGrowthInsideQuoteX128 = response.feeGrowthInsideQuoteX128;
        }

        // TODO move it back if we can fix stack too deep
        _emitLiquidityChanged(trader, params, response, baseFee, quoteFee);
    }

    function _removeOrder(
        address maker,
        address baseToken,
        bytes32 orderId
    ) private {
        MakerPosition storage makerPosition = _accountMap[maker].makerPositionMap[baseToken];
        uint256 idx;
        for (idx = 0; idx < makerPosition.orderIds.length; idx++) {
            if (makerPosition.orderIds[idx] == orderId) {
                // found the existing order ID
                // remove it from the array efficiently by re-ordering and deleting the last element
                makerPosition.orderIds[idx] = makerPosition.orderIds[makerPosition.orderIds.length - 1];
                makerPosition.orderIds.pop();
                break;
            }
        }
        delete makerPosition.openOrderMap[orderId];
    }

    function _settleFunding(address trader, address token) private returns (int256 fundingPayment) {
        // CH_QT should settle only base tokens
        require(token != quoteToken, "CH_QT");

        uint256 historyLen = _fundingHistoryMap[token].length;
        if (_accountMap[trader].nextPremiumFractionIndexMap[token] == historyLen || historyLen == 0) {
            return 0;
        }

        fundingPayment = getPendingFundingPayment(trader, token);
        _accountMap[trader].nextPremiumFractionIndexMap[token] = historyLen;
        uint256 available = _accountMap[trader].tokenInfoMap[quoteToken].available;

        // TODO
        // what if available < fundingPayment?
        require(available.toInt256() > fundingPayment, "TBD");
        _accountMap[trader].tokenInfoMap[quoteToken].available = available.toInt256().sub(fundingPayment).toUint256();

        emit FundingSettled(trader, token, historyLen, fundingPayment);
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        Account storage account = _accountMap[trader];

        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = account.tokenInfoMap[quoteToken].debt;
        uint256 totalPositionValue;
        uint256 totalBaseDebtValue;
        uint256 tokenLen = account.tokens.length;
        for (uint256 i = 0; i < tokenLen; i++) {
            address baseToken = account.tokens[i];
            if (_isPoolExistent(baseToken)) {
                uint256 baseDebtValue = _getDebtValue(baseToken, account.tokenInfoMap[baseToken].debt);
                // will not use negative value in this case
                uint256 positionValue = getPositionValue(trader, baseToken, 0).abs();
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }

        return Math.max(totalPositionValue, totalBaseDebtValue.add(quoteDebtValue)).mul(imRatio).divideBy10_18();
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(_getIndexPrice(token, 0)).divideBy10_18();
    }

    function _getTokenAmountInPool(
        address trader,
        address baseToken,
        uint160 sqrtMarkPriceX96,
        bool includeFee,
        bool fetchBase // true: fetch base amount, false: fetch quote amount
    ) private view returns (uint256 tokenAmount) {
        Account storage account = _accountMap[trader];
        bytes32[] memory orderIds = account.makerPositionMap[baseToken].orderIds;

        //
        // tick:    lower             upper
        //       -|---+-----------------+---|--
        //     case 1                    case 2
        //
        // if current price < upper tick, maker has base
        // case 1 : current price < lower tick
        //  --> maker only has base token
        //
        // if current price > lower tick, maker has quote
        // case 2 : current price > upper tick
        //  --> maker only has quote token
        for (uint256 i = 0; i < orderIds.length; i++) {
            OpenOrder memory order = account.makerPositionMap[baseToken].openOrderMap[orderIds[i]];

            {
                uint256 amount;
                uint160 sqrtPriceAtLowerTick = TickMath.getSqrtRatioAtTick(order.lowerTick);
                uint160 sqrtPriceAtUpperTick = TickMath.getSqrtRatioAtTick(order.upperTick);
                if (fetchBase) {
                    if (sqrtMarkPriceX96 < sqrtPriceAtUpperTick) {
                        if (sqrtMarkPriceX96 > sqrtPriceAtLowerTick) {
                            sqrtPriceAtLowerTick = sqrtMarkPriceX96;
                        }
                        amount = UniswapV3Broker.getAmount0ForLiquidity(
                            sqrtPriceAtLowerTick,
                            sqrtPriceAtUpperTick,
                            order.liquidity
                        );
                    }
                } else {
                    if (sqrtMarkPriceX96 > sqrtPriceAtLowerTick) {
                        if (sqrtMarkPriceX96 < sqrtPriceAtUpperTick) {
                            sqrtPriceAtUpperTick = sqrtMarkPriceX96;
                        }
                        amount = UniswapV3Broker.getAmount1ForLiquidity(
                            sqrtPriceAtLowerTick,
                            sqrtPriceAtUpperTick,
                            order.liquidity
                        );
                    }
                }
                tokenAmount = tokenAmount.add(amount);
            }

            if (includeFee) {
                int24 tick = TickMath.getTickAtSqrtRatio(sqrtMarkPriceX96);
                // include uncollected fee base tokens
                (uint256 feeGrowthInsideBaseX128, uint256 feeGrowthInsideQuoteX128) =
                    UniswapV3Broker.getFeeGrowthInside(_poolMap[baseToken], order.lowerTick, order.upperTick, tick);
                uint256 feeGrowthInsideX128 = feeGrowthInsideQuoteX128;
                uint256 feeGrowthInsideOldX128 = order.feeGrowthInsideQuoteX128;
                if (fetchBase) {
                    feeGrowthInsideX128 = feeGrowthInsideBaseX128;
                    feeGrowthInsideOldX128 = order.feeGrowthInsideBaseX128;
                }
                tokenAmount = tokenAmount.add(
                    _calcOwedFee(order.liquidity, feeGrowthInsideX128, feeGrowthInsideOldX128)
                );
            }
        }
    }

    function _getPositionSize(
        address trader,
        address baseToken,
        uint160 sqrtMarkPriceX96,
        bool includeFee
    ) private view returns (int256) {
        Account storage account = _accountMap[trader];
        uint256 vBaseAmount =
            account.tokenInfoMap[baseToken].available.add(
                _getTokenAmountInPool(trader, baseToken, sqrtMarkPriceX96, includeFee, true)
            );

        // NOTE: when a token goes into UniswapV3 pool (addLiquidity or swap), there would be 1 wei rounding error
        // for instance, maker adds liquidity with 2 base (2000000000000000000),
        // the actual base amount in pool would be 1999999999999999999
        int256 positionSize = vBaseAmount.toInt256().sub(account.tokenInfoMap[baseToken].debt.toInt256());
        return positionSize.abs() < _DUST ? 0 : positionSize;
    }

    // @audit suggest to rename to hasPool or isPoolExist
    function _isPoolExistent(address baseToken) internal view returns (bool) {
        return _poolMap[baseToken] != address(0);
    }

    function _getOrderId(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(address(trader), address(baseToken), lowerTick, upperTick));
    }

    function _calcOwedFee(
        uint128 liquidity,
        uint256 feeGrowthInsideNew,
        uint256 feeGrowthInsideOld
    ) private pure returns (uint256) {
        // TODO can NOT use safeMath, feeGrowthInside could be a very large value(a negative value)
        // which causes underflow but what we want is the difference only
        return FullMath.mulDiv(feeGrowthInsideNew - feeGrowthInsideOld, liquidity, FixedPoint128.Q128);
    }

    function _emitLiquidityChanged(
        address maker,
        AddLiquidityParams memory params,
        UniswapV3Broker.AddLiquidityResponse memory response,
        uint256 baseFee,
        uint256 quoteFee
    ) private {
        emit LiquidityChanged(
            maker,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            response.base.toInt256(),
            response.quote.toInt256(),
            response.liquidity.toInt128(),
            baseFee,
            quoteFee
        );
    }

    function _emitLiquidityChanged(
        address maker,
        InternalRemoveLiquidityParams memory params,
        UniswapV3Broker.RemoveLiquidityResponse memory response,
        uint256 baseFee,
        uint256 quoteFee
    ) private {
        emit LiquidityChanged(
            maker,
            params.baseToken,
            quoteToken,
            params.lowerTick,
            params.upperTick,
            -response.base.toInt256(),
            -response.quote.toInt256(),
            -params.liquidity.toInt128(),
            baseFee,
            quoteFee
        );
    }

    function _requireValidAmount(uint256 amount) private pure {
        // CH_IA: invalid amount
        require(amount > 0, "CH_IA");
    }

    // @audit - suggest rename to _requireHasToken or _requireTokenExist
    function _requireTokenExistent(address token) private view {
        if (quoteToken != token) {
            // CH_TNF: token not found
            require(_isPoolExistent(token), "CH_TNF");
        }
    }

    function _requireLargerThanInitialMarginRequirement(address trader) private view {
        // CH_NEAV: not enough account value
        require(getAccountValue(trader) >= _getTotalInitialMarginRequirement(trader).toInt256(), "CH_NEAV");
    }
}
