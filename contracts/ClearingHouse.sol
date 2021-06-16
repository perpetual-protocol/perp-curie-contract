pragma solidity 0.7.6;

import { ERC20PresetMinterPauser } from "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";

contract ClearingHouse is ReentrancyGuard, Context, Ownable {
    using SafeMath for uint256;
    using SignedSafeMath for int256;
    //
    // events
    //
    event PoolAdded(address indexed base, uint24 indexed feeRatio, address indexed pool);
    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);

    //
    // Struct
    //

    struct Market {
        uint256 imRatio; // initial-margin ratio
        uint256 mmRatio; // minimum-margin ratio
        address[] pools;
    }

    struct Account {
        uint256 collateral;
        address[] tokens;
        // key: token address, e.g. vETH, vUSDC...
        mapping(address => Asset) asset;
    }

    struct Asset {
        uint256 available; // amount available in CH
        uint256 debt;
    }

    //
    // state variables
    //
    address public immutable collateralToken;
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;

    // key: base token
    mapping(address => Market) private _market;

    // key: trader
    mapping(address => Account) private _account;

    //
    // CONSTRUCTOR
    //
    constructor(
        address collateralTokenArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) {
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

        address[] memory pools = _market[baseToken].pools;
        for (uint256 i = 0; i < pools.length; i++) {
            // CH_EP: existent pool in ClearingHouse
            require(pools[i] != pool, "CH_EP");
        }
        _market[baseToken].pools.push(pool);

        emit PoolAdded(baseToken, feeRatio, pool);
    }

    // TODO should add modifier: whenNotPaused()
    function deposit(uint256 amount) external nonReentrant() {
        address trader = _msgSender();
        Account storage account = _account[trader];
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
        // mint vTokens
        if (base > 0 && baseToken != address(0x0)) {
            ERC20PresetMinterPauser(baseToken).mint(address(this), base);
        }
        if (quote > 0) {
            ERC20PresetMinterPauser(quoteToken).mint(address(this), quote);
        }

        // update states
        address trader = _msgSender();
        Asset storage baseAsset = _account[trader].asset[baseToken];
        Asset storage quoteAsset = _account[trader].asset[quoteToken];
        baseAsset.available = baseAsset.available.add(base);
        baseAsset.debt = baseAsset.debt.add(base);
        quoteAsset.available = quoteAsset.available.add(quote);
        quoteAsset.debt = quoteAsset.debt.add(quote);

        require(getFreeCollateral(trader) > 0, "CH_ZFC");
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //
    function getPools(address baseToken) external view returns (address[] memory) {
        return _market[baseToken].pools;
    }

    function getCollateral(address trader) external view returns (uint256) {
        return _account[trader].collateral;
    }

    function getAccountValue(address trader) public view returns (int256) {
        return int256(_account[trader].collateral).add(_getTotalMarketPnl(trader));
    }

    function getFreeCollateral(address trader) public view returns (uint256) {
        int256 freeCollateral = getAccountValue(trader).sub(int256(_getTotalInitialMarginRequirement(trader)));
        return freeCollateral > 0 ? uint256(freeCollateral) : 0;
    }

    function getIndexPrice(address token) public view returns (uint256) {
        // TODO WIP
        return 100 ether;
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //
    function _getTotalMarketPnl(address trader) internal pure returns (int256) {
        return 0; // TODO WIP
    }

    function _getTotalInitialMarginRequirement(address trader) internal view returns (uint256) {
        Account storage account = _account[trader];

        uint256 totalImReq;
        // right now we have only one quote token USDC, which is equivalent to our internal accounting unit.
        uint256 quoteDebtValue = account.asset[quoteToken].debt;
        for (uint256 i = 0; i < account.tokens.length; i++) {
            Market memory market = _market[account.tokens[i]];
            if (market.pools.length > 0) {
                address baseToken = account.tokens[i];
                Asset memory baseAsset = account.asset[baseToken];
                uint256 baseDebtValue = _getDebtValue(baseToken, baseAsset.debt);
                uint256 positionValue = _getPositionValue(account, baseToken);
                uint256 imReq = Math.max(positionValue, Math.max(quoteDebtValue, baseDebtValue));
                totalImReq = totalImReq.add(imReq);
            }
        }

        return totalImReq;
    }

    function _getDebtValue(address token, uint256 amount) private view returns (uint256) {
        return amount.mul(getIndexPrice(token));
    }

    function _getPositionValue(Account storage account, address baseToken) private view returns (uint256) {
        // TODO WIP
        // uint256 positionSize = _getPositionSize(account, baseToken);
        // simulate trade and calculate position value
        // Ex.
        //   poolA, poolB
        //   2    , 3
        //   debt = 4
        //   positionSize = 2 + 3 - 4 = 1
        //   a = getExactBastToQuote(PoolA, 1), b = getExactBastToQuote(PoolB, 1)
        //   c = getExactBastToQuote(PoolA, 0.5) + getExactBastToQuote(PoolB, 0.5)  <-- this is endless
        //   positionValue = max(a, b, c)
        return 0;
    }
}
