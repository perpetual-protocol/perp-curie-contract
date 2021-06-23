pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IUniswapV3MintCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { IMintableERC20 } from "./interface/IMintableERC20.sol";

contract ClearingHouse is IUniswapV3MintCallback, ReentrancyGuard, Context, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SignedSafeMath for int256;
    using SafeCast for int256;
    //
    // events
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Minted(address indexed baseToken, address indexed quoteToken, uint256 base, uint256 quote);
    event LiquidityAdded(
        address indexed baseToken,
        address indexed quoteToken,
        int24 lowerTick,
        int24 upperTick,
        uint256 base,
        uint256 quote,
        uint128 liquidity,
        uint256 baseFee,
        uint256 quoteFee
    );

    //
    // Struct
    //

    struct Account {
        uint256 collateral;
        address[] tokens; // all tokens (incl. quote and base) this account is in debt of
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => TokenInfo) tokenInfoMap; // balance & debt info of each token
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => MakerPosition) makerPositionMap; // open orders for maker
    }

    struct TokenInfo {
        uint256 available; // amount available in CH
        uint256 debt;
        uint256 owedFee;
    }

    struct OpenOrder {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 feeGrowthInsideLastBase;
        uint256 feeGrowthInsideLastQuote;
    }

    struct MakerPosition {
        bytes32[] orderIds;
        // key: order id
        mapping(bytes32 => OpenOrder) openOrderMap;
    }

    struct AddLiquidityParams {
        address baseToken;
        uint256 base;
        uint256 quote;
        int24 lowerTick;
        int24 upperTick;
    }

    //
    // state variables
    //
    uint256 public imRatio = 0.1 ether; // initial-margin ratio, 10%
    uint256 public mmRatio = 0.0625 ether; // minimum-margin ratio, 6.25%

    address public immutable collateralToken;
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;

    // key: base token, value: pool
    mapping(address => address) private _poolMap;

    // key: trader
    mapping(address => Account) private _accountMap;

    constructor(
        address collateralTokenArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) {
        require(collateralTokenArg != address(0), "CH_II_C");
        require(quoteTokenArg != address(0), "CH_II_Q");
        require(uniV3FactoryArg != address(0), "CH_II_U");

        collateralToken = collateralTokenArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(pool != _poolMap[baseToken], "CH_EP");

        _poolMap[baseToken] = pool;
        emit PoolAdded(baseToken, feeRatio, pool);
    }

    // TODO should add modifier: whenNotPaused()
    function deposit(uint256 amount) external nonReentrant() {
        address trader = _msgSender();
        Account storage account = _accountMap[trader];
        account.collateral = account.collateral.add(amount);
        TransferHelper.safeTransferFrom(collateralToken, trader, address(this), amount);

        emit Deposited(collateralToken, trader, amount);
    }

    // TODO should add modifier: whenNotPaused()
    function mint(
        address baseToken,
        uint256 base,
        uint256 quote
    ) external nonReentrant() {
        bool mintBase = base > 0 && baseToken != address(0) && _isPoolExistent(baseToken);
        bool mintQuote = quote > 0;

        // CH_ZI: invalid input
        require(mintBase || mintQuote, "CH_II");

        // mint vTokens
        if (mintBase) {
            IMintableERC20(baseToken).mint(address(this), base);
        }
        if (mintQuote) {
            IMintableERC20(quoteToken).mint(address(this), quote);
        }

        // update internal states
        address trader = _msgSender();
        if (mintBase) {
            TokenInfo storage baseTokenInfo = _accountMap[trader].tokenInfoMap[baseToken];
            baseTokenInfo.available = baseTokenInfo.available.add(base);
            baseTokenInfo.debt = baseTokenInfo.debt.add(base);

            _registerToken(trader, baseToken);
        }

        if (mintQuote) {
            TokenInfo storage quoteTokenInfo = _accountMap[trader].tokenInfoMap[quoteToken];
            quoteTokenInfo.available = quoteTokenInfo.available.add(quote);
            quoteTokenInfo.debt = quoteTokenInfo.debt.add(quote);

            _registerToken(trader, quoteToken);
        }

        // CH_NEAV: not enough account value
        require(getAccountValue(trader) >= _getTotalInitialMarginRequirement(trader).toInt256(), "CH_NEAV");

        emit Minted(baseToken, quoteToken, base, quote);
    }

    function addLiquidity(AddLiquidityParams calldata addLiquidityParams) external nonReentrant() {
        address trader = _msgSender();
        Account storage account = _accountMap[trader];
        address baseToken = addLiquidityParams.baseToken;
        TokenInfo storage baseTokenInfo = account.tokenInfoMap[baseToken];
        TokenInfo storage quoteTokenInfo = account.tokenInfoMap[quoteToken];
        require(baseTokenInfo.available >= addLiquidityParams.base);
        require(quoteTokenInfo.available >= addLiquidityParams.quote);

        // add liquidity to liquidity pool
        UniswapV3Broker.MintResponse memory mintResponse =
            UniswapV3Broker.mint(
                UniswapV3Broker.MintParams(
                    IUniswapV3Pool(_poolMap[baseToken]),
                    baseToken,
                    quoteToken,
                    addLiquidityParams.lowerTick,
                    addLiquidityParams.upperTick,
                    addLiquidityParams.base,
                    addLiquidityParams.quote
                )
            );

        // TODO add slippage protection

        // load existing open order
        bytes32 orderId = _getOrderId(trader, baseToken, addLiquidityParams.lowerTick, addLiquidityParams.upperTick);
        OpenOrder storage openOrderMap = account.makerPositionMap[baseToken].openOrderMap[orderId];
        if (openOrderMap.liquidity == 0) {
            openOrderMap.lowerTick = addLiquidityParams.lowerTick;
            openOrderMap.upperTick = addLiquidityParams.upperTick;
        } else {
            // update token info based on existing open order
            baseTokenInfo.owedFee = baseTokenInfo.owedFee.add(
                openOrderMap.liquidity.toUint256().mul(
                    mintResponse.feeGrowthInsideLastBase.sub(openOrderMap.feeGrowthInsideLastBase)
                )
            );
            quoteTokenInfo.owedFee = quoteTokenInfo.owedFee.add(
                openOrderMap.liquidity.toUint256().mul(
                    mintResponse.feeGrowthInsideLastQuote.sub(openOrderMap.feeGrowthInsideLastQuote)
                )
            );
        }

        // update token info
        baseTokenInfo.available = baseTokenInfo.available.sub(mintResponse.base);
        quoteTokenInfo.available = quoteTokenInfo.available.sub(mintResponse.quote);

        // update open order with new liquidity
        openOrderMap.liquidity = openOrderMap.liquidity.toUint256().add(mintResponse.liquidity.toUint256()).toUint128();
        openOrderMap.feeGrowthInsideLastBase = openOrderMap.feeGrowthInsideLastBase.add(
            mintResponse.feeGrowthInsideLastBase
        );
        openOrderMap.feeGrowthInsideLastQuote = openOrderMap.feeGrowthInsideLastQuote.add(
            mintResponse.feeGrowthInsideLastQuote
        );

        emit LiquidityAdded(
            addLiquidityParams.baseToken,
            quoteToken,
            addLiquidityParams.lowerTick,
            addLiquidityParams.upperTick,
            mintResponse.base,
            mintResponse.quote,
            mintResponse.liquidity,
            baseTokenInfo.owedFee,
            quoteTokenInfo.owedFee
        );
    }

    // @audit: review security and possible attacks (@detoo)
    // @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data // contains baseToken
    ) external override {
        address baseToken = abi.decode(data, (address));
        address pool = _poolMap[baseToken];
        require(_msgSender() == pool, "CH_NPOOL");

        IUniswapV3Pool uniV3Pool = IUniswapV3Pool(pool);
        if (amount0Owed > 0) {
            IMintableERC20(uniV3Pool.token0()).transfer(pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            IMintableERC20(uniV3Pool.token1()).transfer(pool, amount1Owed);
        }
    }

    //
    // INTERNAL FUNCTIONS
    //
    function _registerToken(address trader, address token) private {
        address[] memory tokens = _accountMap[trader].tokens;
        if (tokens.length == 0) {
            _accountMap[trader].tokens.push(token);
        } else {
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

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPool(address baseToken) external view returns (address) {
        return _poolMap[baseToken];
    }

    function getCollateral(address trader) external view returns (uint256) {
        return _accountMap[trader].collateral;
    }

    function getAccountValue(address trader) public view returns (int256) {
        return _accountMap[trader].collateral.toInt256().add(_getTotalMarketPnl(trader));
    }

    function getAccountTokens(address trader) public view returns (address[] memory) {
        return _accountMap[trader].tokens;
    }

    function getFreeCollateral(address trader) public view returns (uint256) {
        int256 freeCollateral = getAccountValue(trader).sub(_getTotalInitialMarginRequirement(trader).toInt256());
        return freeCollateral > 0 ? freeCollateral.toUint256() : 0;
    }

    function getIndexPrice(address token) public view returns (uint256) {
        // TODO WIP
        return 100 ether;
    }

    function getTokenInfo(address trader, address token) external view returns (TokenInfo memory) {
        return _accountMap[trader].tokenInfoMap[token];
    }

    function getOpenOrder(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) external view returns (OpenOrder memory) {
        Account storage account = _accountMap[trader];
        return account.makerPositionMap[baseToken].openOrderMap[_getOrderId(trader, baseToken, lowerTick, upperTick)];
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //
    function _getTotalMarketPnl(address trader) internal pure returns (int256) {
        return 0; // TODO WIP
    }

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
                uint256 positionValue = _getPositionValue(account, baseToken);
                totalBaseDebtValue = totalBaseDebtValue.add(baseDebtValue);
                totalPositionValue = totalPositionValue.add(positionValue);
            }
        }

        return Math.max(totalPositionValue, Math.max(totalBaseDebtValue, quoteDebtValue)).mul(imRatio).div(1 ether);
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(getIndexPrice(token)).div(1 ether);
    }

    function _getPositionValue(Account storage account, address baseToken) private view returns (uint256) {
        // TODO WIP
        // uint256 positionSize = _getPositionSize(account, baseToken);
        // simulate trade and calculate position value
        // positionValue = getExactBastToQuote(pool, 1)
        return 0;
    }

    function _isPoolExistent(address baseToken) internal view returns (bool) {
        return _poolMap[baseToken] != address(0);
    }

    function _getOrderId(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(address(trader), address(baseToken), lowerTick, upperTick));
    }
}
